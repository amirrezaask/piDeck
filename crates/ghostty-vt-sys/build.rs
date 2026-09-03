use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const ZIG_VERSION: &str = "0.15.2";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=tests/abi.c");
    println!("cargo:rerun-if-env-changed=GHOSTTY_SOURCE_DIR");
    println!("cargo:rerun-if-env-changed=GHOSTTY_ZIG");
    println!("cargo:rerun-if-env-changed=GHOSTTY_ZIG_GLOBAL_CACHE_DIR");
    println!("cargo:rerun-if-env-changed=YAADE_GHOSTTY_CACHE_DIR");

    let manifest_dir = PathBuf::from(required_env("CARGO_MANIFEST_DIR"));
    let repository = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("ghostty-vt-sys must remain under <repository>/crates")
        .to_path_buf();
    let version_file = repository.join("packages/ghostty-core/src/vendor/VERSION");
    println!("cargo:rerun-if-changed={}", version_file.display());

    let patch_file = repository.join("patches/ghostty/lib-vt-osc-color-reports.patch");
    println!("cargo:rerun-if-changed={}", patch_file.display());

    let revision = read_revision(&version_file);
    let patch = fs::read(&patch_file)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", patch_file.display()));
    let patch_id = patch_id(&patch);
    let source = source_dir(&revision, patch_id);
    validate_source(&source, &revision, &patch);
    let zig = zig_executable();
    validate_zig(&zig);
    let zig_global_cache = zig_global_cache(&revision, patch_id);

    let target = required_env("TARGET");
    let profile = required_env("PROFILE");
    let optimize = if profile == "release" {
        "ReleaseFast"
    } else {
        "ReleaseSafe"
    };
    let prefix = PathBuf::from(required_env("OUT_DIR"))
        .join("ghostty")
        .join(format!("{revision}-{patch_id:016x}-{target}-{optimize}"));
    let archive = static_archive(&prefix, &target);

    if !archive.is_file() {
        build_ghostty(
            &zig,
            &source,
            &zig_global_cache,
            &prefix,
            &target,
            optimize,
            &revision,
        );
    }
    assert!(
        archive.is_file(),
        "libghostty-vt did not produce the expected static archive: {}",
        archive.display()
    );
    let header = prefix.join("include/ghostty/vt.h");
    assert!(
        header.is_file(),
        "libghostty-vt did not install its public header: {}",
        header.display()
    );

    if target.contains("apple-darwin") {
        run(
            Command::new("ranlib").arg(&archive),
            "ranlib libghostty-vt.a",
        );
    }

    let library_dir = archive
        .parent()
        .expect("static archive must have a parent directory");
    println!("cargo:rustc-link-search=native={}", library_dir.display());
    if target.contains("windows-msvc") {
        println!("cargo:rustc-link-lib=static=ghostty-vt-static");
        println!("cargo:rustc-link-lib=ntdll");
        println!("cargo:rustc-link-lib=kernel32");
    } else {
        println!("cargo:rustc-link-lib=static=ghostty-vt");
    }
    println!("cargo:include={}", prefix.join("include").display());
    println!("cargo:rustc-env=YAADE_GHOSTTY_REVISION={revision}");

    cc::Build::new()
        .file(manifest_dir.join("tests/abi.c"))
        .include(prefix.join("include"))
        .warnings(true)
        .warnings_into_errors(true)
        .compile("yaade_ghostty_abi");
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("required environment variable {name} is missing"))
}

fn read_revision(path: &Path) -> String {
    let revision = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
        .trim()
        .to_owned();
    assert!(
        revision.len() == 40
            && revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "{} must contain one lowercase 40-character Git revision",
        path.display()
    );
    revision
}

fn cache_root() -> PathBuf {
    if let Some(path) = env::var_os("YAADE_GHOSTTY_CACHE_DIR") {
        return PathBuf::from(path);
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .expect("HOME or USERPROFILE is required to locate prepared Ghostty source");
    PathBuf::from(home).join(".cache/yaade/ghostty")
}

fn patch_id(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn source_dir(revision: &str, patch_id: u64) -> PathBuf {
    env::var_os("GHOSTTY_SOURCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            cache_root().join(format!("source-{revision}-yaade-{patch_id:016x}"))
        })
}

fn zig_global_cache(revision: &str, patch_id: u64) -> PathBuf {
    let path = env::var_os("GHOSTTY_ZIG_GLOBAL_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| cache_root().join(format!("zig-global-{ZIG_VERSION}")));
    let stamp = path.join("yaade-prepared");
    let expected = format!("{revision}\n{patch_id:016x}\n{ZIG_VERSION}\n");
    let actual = fs::read_to_string(&stamp).unwrap_or_else(|_| {
        panic!(
            "Ghostty Zig dependencies are not prepared at {}; run `vp run prepare:ghostty`",
            path.display()
        )
    });
    assert_eq!(
        actual, expected,
        "Ghostty Zig dependency cache does not match the pinned revision"
    );
    path
}

fn zig_executable() -> OsString {
    if let Some(path) = env::var_os("GHOSTTY_ZIG") {
        return path;
    }
    let executable = if cfg!(windows) { "zig.exe" } else { "zig" };
    let downloaded = cache_root().join(format!(
        "zig-{ZIG_VERSION}-{}-{}/{}",
        env::consts::OS,
        env::consts::ARCH,
        executable
    ));
    if downloaded.is_file() {
        downloaded.into_os_string()
    } else {
        OsString::from(executable)
    }
}

fn validate_source(source: &Path, revision: &str, patch: &[u8]) {
    if !source.join(".git").is_dir() {
        panic!(
            "Ghostty source is not prepared at {}; run `vp run prepare:ghostty`",
            source.display()
        );
    }
    let head = capture(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(source),
        "read prepared Ghostty revision",
    );
    assert_eq!(
        head,
        revision,
        "prepared Ghostty source at {} has the wrong revision; run `vp run prepare:ghostty`",
        source.display()
    );
    let diff = capture_bytes(
        Command::new("git")
            .args(["diff", "--binary", "--no-ext-diff", "HEAD", "--"])
            .current_dir(source),
        "check prepared Ghostty patch",
    );
    assert_eq!(
        diff,
        patch,
        "prepared Ghostty source at {} does not match the repository patch",
        source.display()
    );
}

fn validate_zig(zig: &OsString) {
    let version = capture(Command::new(zig).arg("version"), "read Zig version");
    assert_eq!(
        version, ZIG_VERSION,
        "libghostty-vt requires Zig {ZIG_VERSION}; run `vp run prepare:ghostty`"
    );
}

fn zig_target(target: &str) -> &str {
    match target {
        "aarch64-apple-darwin" => "aarch64-macos",
        "x86_64-apple-darwin" => "x86_64-macos",
        "aarch64-unknown-linux-gnu" => "aarch64-linux-gnu",
        "x86_64-unknown-linux-gnu" => "x86_64-linux-gnu",
        "aarch64-unknown-linux-musl" => "aarch64-linux-musl",
        "x86_64-unknown-linux-musl" => "x86_64-linux-musl",
        "aarch64-pc-windows-msvc" => "aarch64-windows-msvc",
        "x86_64-pc-windows-msvc" => "x86_64-windows-msvc",
        unsupported => panic!("unsupported native libghostty-vt target: {unsupported}"),
    }
}

fn static_archive(prefix: &Path, target: &str) -> PathBuf {
    if target.contains("windows-msvc") {
        prefix.join("lib/ghostty-vt-static.lib")
    } else {
        prefix.join("lib/libghostty-vt.a")
    }
}

fn build_ghostty(
    zig: &OsString,
    source: &Path,
    zig_global_cache: &Path,
    prefix: &Path,
    target: &str,
    optimize: &str,
    revision: &str,
) {
    fs::create_dir_all(prefix)
        .unwrap_or_else(|error| panic!("failed to create {}: {error}", prefix.display()));
    let mut command = Command::new(zig);
    command
        .current_dir(source)
        .arg("build")
        .arg("-Demit-lib-vt=true")
        .arg("-Dsimd=false")
        .arg("-Dapp-runtime=none")
        .arg("-Demit-xcframework=false")
        .arg(format!("-Dtarget={}", zig_target(target)))
        .arg(format!("-Doptimize={optimize}"))
        .arg(format!("-Dlib-version-string=0.1.0-dev+{revision}"))
        .arg("--prefix")
        .arg(prefix)
        .arg("--cache-dir")
        .arg(prefix.join("zig-cache"))
        .arg("--global-cache-dir")
        .arg(zig_global_cache)
        .arg("--system")
        .arg(zig_global_cache.join("p"));
    run(&mut command, "build native libghostty-vt");
}

fn capture_bytes(command: &mut Command, description: &str) -> Vec<u8> {
    let output = command
        .output()
        .unwrap_or_else(|error| panic!("failed to {description}: {error}"));
    ensure_success(&output, description);
    output.stdout
}

fn capture(command: &mut Command, description: &str) -> String {
    let output = command
        .output()
        .unwrap_or_else(|error| panic!("failed to {description}: {error}"));
    ensure_success(&output, description);
    String::from_utf8(output.stdout)
        .unwrap_or_else(|error| panic!("{description} returned non-UTF-8 output: {error}"))
        .trim()
        .to_owned()
}

fn run(command: &mut Command, description: &str) {
    let output = command
        .output()
        .unwrap_or_else(|error| panic!("failed to {description}: {error}"));
    ensure_success(&output, description);
}

fn ensure_success(output: &Output, description: &str) {
    if output.status.success() {
        return;
    }
    panic!(
        "failed to {description} ({}):\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
