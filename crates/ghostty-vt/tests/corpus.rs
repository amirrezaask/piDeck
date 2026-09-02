//! Native runner for the bounded native/WASM Ghostty differential corpus.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ghostty_vt::{
    ActiveScreen, CellStyle, CellWidth, ColorScheme, CursorVisualStyle, DeviceAttributes,
    EffectLimits, EffectOptions, Mode, RenderColors, Rgb, SemanticContent, SemanticPrompt,
    StyleColor, Terminal, TerminalOptions, Underline, build_revision,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const FORMAT_VERSION: u32 = 1;
const NORMALIZER_VERSION: u32 = 1;
const HARD_MAX_FIXTURE_BYTES: usize = 1_048_576;
const HARD_MAX_FIXTURES: usize = 64;
const HARD_MAX_COLUMNS: usize = 256;
const HARD_MAX_ROWS: usize = 128;
const HARD_MAX_CELL_PIXELS: usize = 4_096;
const HARD_MAX_SCROLLBACK: usize = 100_000;
const HARD_MAX_EVENTS: usize = 10_000;
const HARD_MAX_OBSERVATIONS: usize = 128;
const HARD_MAX_EFFECT_BYTES: usize = 1_048_576;
const HARD_MAX_OBSERVATION_BYTES: usize = 16_777_216;

type CorpusResult<T> = Result<T, String>;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    normalizer_version: u32,
    limits: Limits,
    modes: Vec<ModeSpec>,
    fixtures: Vec<Fixture>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Limits {
    max_fixture_bytes: usize,
    max_columns: usize,
    max_rows: usize,
    max_events: usize,
    max_effects_bytes: usize,
    max_observation_bytes: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModeSpec {
    number: u16,
    ansi: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    id: String,
    purpose: String,
    bytes: ByteFile,
    initial: InitialOptions,
    assertions: String,
    events: Vec<Event>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ByteFile {
    path: String,
    length: usize,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialOptions {
    columns: usize,
    rows: usize,
    cell_width: usize,
    cell_height: usize,
    scrollback: usize,
    default_cursor_blink: bool,
    theme: Theme,
    host: HostOptions,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Theme {
    foreground: Color,
    background: Color,
    cursor: Color,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Color {
    r: u8,
    g: u8,
    b: u8,
}

impl From<Color> for Rgb {
    fn from(value: Color) -> Self {
        Self {
            r: value.r,
            g: value.g,
            b: value.b,
        }
    }
}

impl From<Rgb> for Color {
    fn from(value: Rgb) -> Self {
        Self {
            r: value.r,
            g: value.g,
            b: value.b,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostOptions {
    enquiry_base64: String,
    xtversion_base64: String,
    color_scheme: Option<HostColorScheme>,
    device_attributes: Option<HostDeviceAttributes>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum HostColorScheme {
    Light,
    Dark,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostDeviceAttributes {
    primary_conformance_level: u16,
    primary_features: Vec<u16>,
    secondary_device_type: u16,
    secondary_firmware_version: u16,
    secondary_rom_cartridge: u16,
    tertiary_unit_id: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Event {
    Write {
        offset: usize,
        length: usize,
    },
    Resize {
        columns: usize,
        rows: usize,
        cell_width: usize,
        cell_height: usize,
    },
    Reset,
    Theme {
        theme: Theme,
    },
    Scroll {
        position: ScrollPosition,
    },
    Observe {
        id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ScrollPosition {
    Top,
    Bottom,
}

#[derive(Debug)]
struct LoadedFixture {
    definition: Fixture,
    payload: Vec<u8>,
    assertions: Assertions,
}

#[derive(Debug)]
struct LoadedCorpus {
    manifest: Manifest,
    fixtures: Vec<LoadedFixture>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Assertions {
    fixture_id: String,
    observations: Vec<ObservationAssertion>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservationAssertion {
    id: String,
    title_base64: Option<String>,
    working_directory_base64: Option<String>,
    cursor: Option<Position>,
    active_screen: Option<Screen>,
    dimensions: Option<DimensionsAssertion>,
    scrollbar: Option<Scrollbar>,
    kitty_keyboard_flags: Option<u8>,
    rows: Vec<RowAssertion>,
    cells: Vec<CellAssertion>,
    palette: Vec<PaletteAssertion>,
    modes: Vec<ModeObservation>,
    effects: Vec<EffectAssertion>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DimensionsAssertion {
    columns: u16,
    rows: u16,
    width_pixels: u32,
    height_pixels: u32,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RowAssertion {
    row: usize,
    wraps_to_next: bool,
    is_wrap_continuation: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PaletteAssertion {
    index: usize,
    color: Color,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CellAssertion {
    row: usize,
    column: usize,
    grapheme_base64: String,
    width: Option<Width>,
    style: Option<Style>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectAssertion {
    event_index: usize,
    callback_index: usize,
    base64: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerOutput {
    normalizer_version: u32,
    revision: String,
    runner: &'static str,
    fixtures: Vec<FixtureOutput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureOutput {
    id: String,
    source_length: usize,
    source_sha256: String,
    observations: Vec<Observation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    id: String,
    event_index: usize,
    state: State,
    render_colors: Colors,
    cursor: Cursor,
    modes: Vec<ModeObservation>,
    rows: Vec<Row>,
    effects: Vec<Effect>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    columns: u16,
    rows: u16,
    width_pixels: u32,
    height_pixels: u32,
    active_screen: Screen,
    alternate_screen: bool,
    total_rows: usize,
    scrollback_rows: usize,
    viewport_active: bool,
    scrollbar: Scrollbar,
    kitty_keyboard_flags: u8,
    title: EncodedBytes,
    working_directory: EncodedBytes,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Screen {
    Primary,
    Alternate,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
struct Scrollbar {
    total: u64,
    offset: u64,
    length: u64,
}

#[derive(Clone, Debug, Serialize)]
struct Colors {
    foreground: Color,
    background: Color,
    cursor: Option<Color>,
    palette: Vec<Color>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
struct Position {
    column: u16,
    row: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    column: u16,
    row: u16,
    pending_wrap: bool,
    visible: bool,
    render_style: CursorStyle,
    blinking: bool,
    password_input: bool,
    viewport_position: Option<Position>,
    wide_tail: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CursorStyle {
    Bar,
    Block,
    Underline,
    HollowBlock,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ModeObservation {
    number: u16,
    ansi: bool,
    enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    index: u16,
    wraps_to_next: bool,
    is_wrap_continuation: bool,
    semantic_prompt: PromptKind,
    selection: Option<Selection>,
    cells: Vec<Cell>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PromptKind {
    None,
    Prompt,
    Continuation,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct Selection {
    start: u16,
    end: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cell {
    column: u16,
    grapheme: EncodedBytes,
    width: Width,
    semantic_content: Content,
    style: Style,
    selected: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Width {
    Narrow,
    Wide,
    SpacerTail,
    SpacerHead,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Content {
    Output,
    Input,
    Prompt,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Style {
    foreground: Color,
    background: Color,
    foreground_source: StyleSource,
    background_source: StyleSource,
    underline_color_source: StyleSource,
    bold: bool,
    italic: bool,
    faint: bool,
    blink: bool,
    inverse: bool,
    invisible: bool,
    strikethrough: bool,
    overline: bool,
    underline: Decoration,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum StyleSource {
    None,
    Palette { index: u8 },
    Rgb { color: Color },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Decoration {
    None,
    Single,
    Double,
    Curly,
    Dotted,
    Dashed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Effect {
    event_index: usize,
    callback_index: usize,
    bytes: EncodedBytes,
}

#[derive(Clone, Debug, Serialize)]
struct EncodedBytes {
    base64: String,
    length: usize,
    sha256: String,
}

fn corpus_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/terminal-corpus")
}

fn read_bounded(path: &Path, limit: usize, label: &str) -> CorpusResult<Vec<u8>> {
    let metadata = fs::metadata(path).map_err(|error| format!("{label}: {error}"))?;
    let size = usize::try_from(metadata.len()).map_err(|_| format!("{label} is oversized"))?;
    if !metadata.is_file() || size > limit {
        return Err(format!("{label} is oversized or unavailable"));
    }
    fs::read(path).map_err(|error| format!("{label}: {error}"))
}

fn load_corpus(root: &Path) -> CorpusResult<LoadedCorpus> {
    let manifest_bytes = read_bounded(
        &root.join("manifest.json"),
        HARD_MAX_OBSERVATION_BYTES,
        "manifest",
    )?;
    let manifest: Manifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| format!("manifest: {error}"))?;
    validate_manifest(&manifest)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("corpus root: {error}"))?;
    let mut loaded = Vec::with_capacity(manifest.fixtures.len());
    for fixture in &manifest.fixtures {
        let payload_file = format!("{}.bin", fixture.id);
        let payload_path = checked_corpus_path(
            &canonical_root,
            &fixture.bytes.path,
            &[payload_file.as_str()],
            "byte path",
        )?;
        let payload = read_bounded(
            &payload_path,
            manifest.limits.max_fixture_bytes,
            &fixture.id,
        )?;
        if payload.len() != fixture.bytes.length {
            return Err(format!("{} byte length mismatch", fixture.id));
        }
        if sha256(&payload) != fixture.bytes.sha256 {
            return Err(format!("{} SHA-256 mismatch", fixture.id));
        }
        let assertion_file = format!("{}.json", fixture.id);
        let assertions_path = checked_corpus_path(
            &canonical_root,
            &fixture.assertions,
            &["assertions", assertion_file.as_str()],
            "assertions path",
        )?;
        let assertions: Assertions = serde_json::from_slice(&read_bounded(
            &assertions_path,
            HARD_MAX_OBSERVATION_BYTES,
            &format!("{} assertions", fixture.id),
        )?)
        .map_err(|error| format!("{} assertions: {error}", fixture.id))?;
        validate_assertions(fixture, &assertions)?;
        loaded.push(LoadedFixture {
            definition: fixture.clone(),
            payload,
            assertions,
        });
    }
    Ok(LoadedCorpus {
        manifest,
        fixtures: loaded,
    })
}

fn checked_corpus_path(
    root: &Path,
    relative: &str,
    expected_components: &[&str],
    label: &str,
) -> CorpusResult<PathBuf> {
    let path = Path::new(relative);
    let components: Vec<&str> = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .ok_or_else(|| format!("{label} is not UTF-8")),
            _ => Err(format!(
                "{label} contains traversal or an absolute component"
            )),
        })
        .collect::<CorpusResult<_>>()?;
    if components != expected_components {
        return Err(format!("{label} does not match its fixture id"));
    }
    let resolved = root.join(path);
    let canonical = resolved
        .canonicalize()
        .map_err(|error| format!("{label}: {error}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("{label} escapes the corpus root"));
    }
    Ok(canonical)
}

fn validate_manifest(manifest: &Manifest) -> CorpusResult<()> {
    if manifest.format_version != FORMAT_VERSION
        || manifest.normalizer_version != NORMALIZER_VERSION
    {
        return Err("unsupported corpus or normalizer version".into());
    }
    if manifest.fixtures.is_empty() || manifest.fixtures.len() > HARD_MAX_FIXTURES {
        return Err("fixture count is out of bounds".into());
    }
    let limits = &manifest.limits;
    bounded(
        limits.max_fixture_bytes,
        1,
        HARD_MAX_FIXTURE_BYTES,
        "maxFixtureBytes",
    )?;
    bounded(limits.max_columns, 1, HARD_MAX_COLUMNS, "maxColumns")?;
    bounded(limits.max_rows, 1, HARD_MAX_ROWS, "maxRows")?;
    bounded(limits.max_events, 1, HARD_MAX_EVENTS, "maxEvents")?;
    bounded(
        limits.max_effects_bytes,
        1,
        HARD_MAX_EFFECT_BYTES,
        "maxEffectsBytes",
    )?;
    bounded(
        limits.max_observation_bytes,
        1,
        HARD_MAX_OBSERVATION_BYTES,
        "maxObservationBytes",
    )?;
    let mut fixture_ids = HashSet::new();
    let mut modes = HashSet::new();
    for mode in &manifest.modes {
        if mode.number > 0x7fff || !modes.insert((mode.number, mode.ansi)) {
            return Err(format!("invalid or duplicate mode {}", mode.number));
        }
    }
    for fixture in &manifest.fixtures {
        if !valid_id(&fixture.id) || !fixture_ids.insert(fixture.id.as_str()) {
            return Err(format!("invalid or duplicate fixture id: {}", fixture.id));
        }
        if fixture.purpose.is_empty() || fixture.purpose.len() > 512 {
            return Err(format!("{} purpose is empty or oversized", fixture.id));
        }
        if fixture.bytes.path != format!("{}.bin", fixture.id) {
            return Err(format!("{} has an invalid byte path", fixture.id));
        }
        if fixture.assertions != format!("assertions/{}.json", fixture.id) {
            return Err(format!("{} has an invalid assertions path", fixture.id));
        }
        bounded(
            fixture.bytes.length,
            1,
            limits.max_fixture_bytes,
            &format!("{}.bytes.length", fixture.id),
        )?;
        if !valid_hash(&fixture.bytes.sha256) {
            return Err(format!("{} has an invalid SHA-256", fixture.id));
        }
        validate_dimensions(
            &fixture.id,
            fixture.initial.columns,
            fixture.initial.rows,
            fixture.initial.cell_width,
            fixture.initial.cell_height,
            limits,
        )?;
        bounded(
            fixture.initial.scrollback,
            0,
            HARD_MAX_SCROLLBACK,
            &format!("{}.scrollback", fixture.id),
        )?;
        decode_canonical_base64(&fixture.initial.host.enquiry_base64, 4_096, "enquiry")?;
        decode_canonical_base64(&fixture.initial.host.xtversion_base64, 4_096, "xtversion")?;
        if fixture
            .initial
            .host
            .device_attributes
            .as_ref()
            .is_some_and(|device| device.primary_features.len() > 64)
        {
            return Err(format!("{} has too many device features", fixture.id));
        }
        bounded(
            fixture.events.len(),
            1,
            limits.max_events,
            &format!("{}.events", fixture.id),
        )?;
        let mut consumed = 0usize;
        let mut observations = HashSet::new();
        for (event_index, event) in fixture.events.iter().enumerate() {
            match event {
                Event::Write { offset, length } => {
                    if *length == 0
                        || *offset != consumed
                        || offset.saturating_add(*length) > fixture.bytes.length
                    {
                        return Err(format!(
                            "{} has a malformed chunk schedule at event {event_index}",
                            fixture.id
                        ));
                    }
                    consumed += length;
                }
                Event::Resize {
                    columns,
                    rows,
                    cell_width,
                    cell_height,
                } => validate_dimensions(
                    &fixture.id,
                    *columns,
                    *rows,
                    *cell_width,
                    *cell_height,
                    limits,
                )?,
                Event::Observe { id } => {
                    if consumed == 0 || !valid_id(id) || !observations.insert(id.as_str()) {
                        return Err(format!(
                            "{} has an invalid observation at event {event_index}",
                            fixture.id
                        ));
                    }
                }
                Event::Reset | Event::Theme { .. } | Event::Scroll { .. } => {}
            }
        }
        if consumed != fixture.bytes.length {
            return Err(format!(
                "{} chunk schedule does not cover its byte file",
                fixture.id
            ));
        }
        bounded(
            observations.len(),
            1,
            HARD_MAX_OBSERVATIONS,
            &format!("{}.observations", fixture.id),
        )?;
    }
    Ok(())
}

fn validate_dimensions(
    fixture: &str,
    columns: usize,
    rows: usize,
    cell_width: usize,
    cell_height: usize,
    limits: &Limits,
) -> CorpusResult<()> {
    bounded(
        columns,
        1,
        limits.max_columns,
        &format!("{fixture}.columns"),
    )?;
    bounded(rows, 1, limits.max_rows, &format!("{fixture}.rows"))?;
    bounded(
        cell_width,
        1,
        HARD_MAX_CELL_PIXELS,
        &format!("{fixture}.cellWidth"),
    )?;
    bounded(
        cell_height,
        1,
        HARD_MAX_CELL_PIXELS,
        &format!("{fixture}.cellHeight"),
    )
}

fn bounded(value: usize, minimum: usize, maximum: usize, label: &str) -> CorpusResult<()> {
    if value < minimum || value > maximum {
        Err(format!("{label} must be between {minimum} and {maximum}"))
    } else {
        Ok(())
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_assertions(fixture: &Fixture, assertions: &Assertions) -> CorpusResult<()> {
    if assertions.fixture_id != fixture.id {
        return Err(format!("{} assertion fixture id mismatch", fixture.id));
    }
    let scheduled: Vec<&str> = fixture
        .events
        .iter()
        .filter_map(|event| match event {
            Event::Observe { id } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    let asserted: Vec<&str> = assertions
        .observations
        .iter()
        .map(|observation| observation.id.as_str())
        .collect();
    if scheduled != asserted {
        return Err(format!(
            "{} assertion observation ids do not match the schedule",
            fixture.id
        ));
    }
    for observation in &assertions.observations {
        let mut cells = HashSet::new();
        for row in &observation.rows {
            bounded(row.row, 0, HARD_MAX_ROWS - 1, "assertion row")?;
        }
        for cell in &observation.cells {
            if !cells.insert((cell.row, cell.column)) {
                return Err(format!(
                    "{}.{} has a duplicate cell assertion",
                    fixture.id, observation.id
                ));
            }
            decode_canonical_base64(&cell.grapheme_base64, 16_384, "assertion grapheme")?;
        }
        for entry in &observation.palette {
            bounded(entry.index, 0, 255, "assertion palette index")?;
        }
        for effect in &observation.effects {
            decode_canonical_base64(&effect.base64, HARD_MAX_EFFECT_BYTES, "assertion effect")?;
        }
    }
    Ok(())
}

fn run_corpus(corpus: &LoadedCorpus) -> CorpusResult<RunnerOutput> {
    let revision = build_revision()
        .map_err(|error| format!("Ghostty build revision: {error}"))?
        .to_owned();
    let fixtures = corpus
        .fixtures
        .iter()
        .map(|fixture| run_fixture(&corpus.manifest, fixture))
        .collect::<CorpusResult<Vec<_>>>()?;
    Ok(RunnerOutput {
        normalizer_version: NORMALIZER_VERSION,
        revision,
        runner: "native",
        fixtures,
    })
}

fn run_fixture(manifest: &Manifest, fixture: &LoadedFixture) -> CorpusResult<FixtureOutput> {
    let options = &fixture.definition.initial;
    let effects = effect_options(&options.host, &manifest.limits)?;
    let mut terminal = Terminal::new(TerminalOptions {
        cols: options.columns,
        rows: options.rows,
        scrollback: options.scrollback,
        effects,
    })
    .map_err(|error| format!("{} terminal create: {error}", fixture.definition.id))?;
    terminal
        .set_default_cursor_blink(options.default_cursor_blink)
        .map_err(|error| format!("{} cursor default: {error}", fixture.definition.id))?;
    apply_theme(&mut terminal, &options.theme, &fixture.definition.id)?;
    terminal
        .resize(
            options.columns,
            options.rows,
            options.cell_width,
            options.cell_height,
        )
        .map_err(|error| format!("{} initial resize: {error}", fixture.definition.id))?;

    let mut observed_effects = Vec::new();
    let mut observations = Vec::new();
    for (event_index, event) in fixture.definition.events.iter().enumerate() {
        match event {
            Event::Write { offset, length } => {
                let end = offset + length;
                let outcome = terminal
                    .write(&fixture.payload[*offset..end])
                    .map_err(|error| {
                        format!(
                            "{} event {event_index} write: {error}",
                            fixture.definition.id
                        )
                    })?;
                capture_effects(event_index, outcome.pty_responses(), &mut observed_effects);
            }
            Event::Resize {
                columns,
                rows,
                cell_width,
                cell_height,
            } => {
                let outcome = terminal
                    .resize(*columns, *rows, *cell_width, *cell_height)
                    .map_err(|error| {
                        format!(
                            "{} event {event_index} resize: {error}",
                            fixture.definition.id
                        )
                    })?;
                capture_effects(event_index, outcome.pty_responses(), &mut observed_effects);
            }
            Event::Reset => terminal.reset(),
            Event::Theme { theme } => apply_theme(&mut terminal, theme, &fixture.definition.id)?,
            Event::Scroll { position } => match position {
                ScrollPosition::Top => terminal.scroll_viewport_top(),
                ScrollPosition::Bottom => terminal.scroll_viewport_bottom(),
            },
            Event::Observe { id } => {
                let observation =
                    observe(&mut terminal, manifest, id, event_index, &observed_effects)?;
                assert_hand_authored(fixture, &observation)?;
                observations.push(observation);
            }
        }
    }
    Ok(FixtureOutput {
        id: fixture.definition.id.clone(),
        source_length: fixture.payload.len(),
        source_sha256: sha256(&fixture.payload),
        observations,
    })
}

fn effect_options(host: &HostOptions, limits: &Limits) -> CorpusResult<EffectOptions> {
    let color_scheme = host.color_scheme.map(|value| match value {
        HostColorScheme::Light => ColorScheme::Light,
        HostColorScheme::Dark => ColorScheme::Dark,
    });
    let device_attributes = host
        .device_attributes
        .as_ref()
        .map(|value| DeviceAttributes {
            primary_conformance_level: value.primary_conformance_level,
            primary_features: value.primary_features.clone(),
            secondary_device_type: value.secondary_device_type,
            secondary_firmware_version: value.secondary_firmware_version,
            secondary_rom_cartridge: value.secondary_rom_cartridge,
            tertiary_unit_id: value.tertiary_unit_id,
        });
    Ok(EffectOptions {
        limits: EffectLimits {
            pty_response_bytes: limits.max_effects_bytes,
            pty_responses: 4_096,
            text_bytes: 64 * 1024,
            bells: 65_536,
            queries: 65_536,
        },
        size: None,
        color_scheme,
        device_attributes,
        enquiry_response: decode_canonical_base64(&host.enquiry_base64, 4_096, "enquiry")?,
        xtversion: decode_canonical_base64(&host.xtversion_base64, 4_096, "xtversion")?,
    })
}

fn apply_theme(terminal: &mut Terminal, theme: &Theme, fixture: &str) -> CorpusResult<()> {
    terminal
        .set_default_colors(
            Some(theme.foreground.into()),
            Some(theme.background.into()),
            Some(theme.cursor.into()),
        )
        .map_err(|error| format!("{fixture} set theme: {error}"))?;
    terminal
        .set_default_palette(None)
        .map_err(|error| format!("{fixture} set palette: {error}"))
}

fn capture_effects<'a>(
    event_index: usize,
    responses: impl Iterator<Item = &'a [u8]>,
    output: &mut Vec<Effect>,
) {
    output.extend(responses.enumerate().map(|(callback_index, bytes)| Effect {
        event_index,
        callback_index,
        bytes: encode_bytes(bytes),
    }));
}

fn observe(
    terminal: &mut Terminal,
    manifest: &Manifest,
    id: &str,
    event_index: usize,
    effects: &[Effect],
) -> CorpusResult<Observation> {
    let state = terminal
        .state()
        .map_err(|error| format!("observation {id} state: {error}"))?;
    let modes = manifest
        .modes
        .iter()
        .map(|mode| {
            let checked = Mode::new(mode.number, mode.ansi)
                .map_err(|error| format!("observation {id} mode {}: {error}", mode.number))?;
            Ok(ModeObservation {
                number: mode.number,
                ansi: mode.ansi,
                enabled: terminal
                    .mode(checked)
                    .map_err(|error| format!("observation {id} mode {}: {error}", mode.number))?,
            })
        })
        .collect::<CorpusResult<Vec<_>>>()?;
    let terminal_state = State {
        columns: state.columns,
        rows: state.rows,
        width_pixels: state.width_pixels,
        height_pixels: state.height_pixels,
        active_screen: match state.active_screen {
            ActiveScreen::Primary => Screen::Primary,
            ActiveScreen::Alternate => Screen::Alternate,
        },
        alternate_screen: state.alternate_screen,
        total_rows: state.total_rows,
        scrollback_rows: state.scrollback_rows,
        viewport_active: state.viewport_active,
        scrollbar: Scrollbar {
            total: state.scrollbar.total,
            offset: state.scrollbar.offset,
            length: state.scrollbar.length,
        },
        kitty_keyboard_flags: state.kitty_keyboard_flags,
        title: encode_bytes(state.title.as_bytes()),
        working_directory: encode_bytes(state.working_directory.as_bytes()),
    };
    let pending_wrap = state.cursor_pending_wrap;
    let cursor_column = state.cursor_column;
    let cursor_row = state.cursor_row;
    let cursor_visible = state.cursor_visible;
    let mut rows = Vec::new();
    let mut colors = None;
    let mut render_cursor = None;
    terminal
        .with_render_state(|render| {
            let render_colors = render.colors().clone();
            let cursor = render.cursor();
            colors = Some(colors_from_render(&render_colors));
            render_cursor = Some(cursor);
            while let Some(mut row) = render.next_row()? {
                let selection = row.selection()?.map(|value| Selection {
                    start: value.start,
                    end: value.end,
                });
                let mut cells = Vec::with_capacity(usize::from(state.columns));
                while let Some(mut cell) = row.next_cell()? {
                    let grapheme = encode_bytes(cell.grapheme_bytes()?);
                    let native_style = cell.style()?;
                    let foreground = cell.foreground()?.unwrap_or(render_colors.foreground);
                    let background = cell.background()?.unwrap_or(render_colors.background);
                    cells.push(Cell {
                        column: cell.column(),
                        grapheme,
                        width: width(cell.width()?),
                        semantic_content: content(cell.semantic_content()?),
                        style: normalized_style(native_style, foreground, background),
                        selected: cell.is_selected()?,
                    });
                }
                rows.push(Row {
                    index: row.index(),
                    wraps_to_next: row.wraps_to_next()?,
                    is_wrap_continuation: row.is_wrap_continuation()?,
                    semantic_prompt: prompt(row.semantic_prompt()?),
                    selection,
                    cells,
                });
            }
            Ok(())
        })
        .map_err(|error| format!("observation {id} render: {error}"))?;
    let colors = colors.ok_or_else(|| format!("observation {id} missing render colors"))?;
    let render_cursor =
        render_cursor.ok_or_else(|| format!("observation {id} missing render cursor"))?;
    if rows.len() != usize::from(state.rows) {
        return Err(format!("observation {id} returned an incomplete viewport"));
    }
    Ok(Observation {
        id: id.to_owned(),
        event_index,
        state: terminal_state,
        render_colors: colors,
        cursor: Cursor {
            column: cursor_column,
            row: cursor_row,
            pending_wrap,
            visible: cursor_visible,
            render_style: match render_cursor.style {
                CursorVisualStyle::Bar => CursorStyle::Bar,
                CursorVisualStyle::Block => CursorStyle::Block,
                CursorVisualStyle::Underline => CursorStyle::Underline,
                CursorVisualStyle::HollowBlock => CursorStyle::HollowBlock,
            },
            blinking: render_cursor.blinking,
            password_input: render_cursor.password_input,
            viewport_position: render_cursor.viewport_position.map(|value| Position {
                column: value.column,
                row: value.row,
            }),
            wide_tail: render_cursor.wide_tail,
        },
        modes,
        rows,
        effects: effects.to_vec(),
    })
}

fn colors_from_render(colors: &RenderColors) -> Colors {
    Colors {
        foreground: colors.foreground.into(),
        background: colors.background.into(),
        cursor: colors.cursor.map(Into::into),
        palette: colors.palette.iter().copied().map(Into::into).collect(),
    }
}

fn normalized_style(style: CellStyle, mut foreground: Rgb, background: Rgb) -> Style {
    let mut background = background;
    if style.inverse {
        std::mem::swap(&mut foreground, &mut background);
    }
    if style.faint {
        foreground = Rgb {
            r: blend(foreground.r, background.r),
            g: blend(foreground.g, background.g),
            b: blend(foreground.b, background.b),
        };
    }
    Style {
        foreground: foreground.into(),
        background: background.into(),
        foreground_source: style_source(style.foreground),
        background_source: style_source(style.background),
        underline_color_source: style_source(style.underline_color),
        bold: style.bold,
        italic: style.italic,
        faint: style.faint,
        blink: style.blink,
        inverse: style.inverse,
        invisible: style.invisible,
        strikethrough: style.strikethrough,
        overline: style.overline,
        underline: decoration(style.underline),
    }
}

fn blend(foreground: u8, background: u8) -> u8 {
    (u16::from(foreground) + u16::from(background)).div_ceil(2) as u8
}

fn width(value: CellWidth) -> Width {
    match value {
        CellWidth::Narrow => Width::Narrow,
        CellWidth::Wide => Width::Wide,
        CellWidth::SpacerTail => Width::SpacerTail,
        CellWidth::SpacerHead => Width::SpacerHead,
    }
}

fn content(value: SemanticContent) -> Content {
    match value {
        SemanticContent::Output => Content::Output,
        SemanticContent::Input => Content::Input,
        SemanticContent::Prompt => Content::Prompt,
    }
}

fn prompt(value: SemanticPrompt) -> PromptKind {
    match value {
        SemanticPrompt::None => PromptKind::None,
        SemanticPrompt::Prompt => PromptKind::Prompt,
        SemanticPrompt::Continuation => PromptKind::Continuation,
    }
}

fn style_source(value: StyleColor) -> StyleSource {
    match value {
        StyleColor::None => StyleSource::None,
        StyleColor::Palette(index) => StyleSource::Palette { index },
        StyleColor::Rgb(color) => StyleSource::Rgb {
            color: color.into(),
        },
    }
}

fn decoration(value: Underline) -> Decoration {
    match value {
        Underline::None => Decoration::None,
        Underline::Single => Decoration::Single,
        Underline::Double => Decoration::Double,
        Underline::Curly => Decoration::Curly,
        Underline::Dotted => Decoration::Dotted,
        Underline::Dashed => Decoration::Dashed,
    }
}

fn assert_hand_authored(fixture: &LoadedFixture, observation: &Observation) -> CorpusResult<()> {
    let expected = fixture
        .assertions
        .observations
        .iter()
        .find(|value| value.id == observation.id)
        .ok_or_else(|| {
            format!(
                "{}.{} has no hand-authored assertion entry",
                fixture.definition.id, observation.id
            )
        })?;
    let location = format!("{}.{}", fixture.definition.id, observation.id);
    if let Some(value) = &expected.title_base64
        && observation.state.title.base64 != *value
    {
        return Err(format!(
            "{location} title: expected {value}, got {}",
            observation.state.title.base64
        ));
    }
    if let Some(value) = &expected.working_directory_base64
        && observation.state.working_directory.base64 != *value
    {
        return Err(format!(
            "{location} cwd: expected {value}, got {}",
            observation.state.working_directory.base64
        ));
    }
    if let Some(value) = expected.active_screen
        && observation.state.active_screen != value
    {
        return Err(format!(
            "{location} active screen: expected {value:?}, got {:?}",
            observation.state.active_screen
        ));
    }
    if let Some(value) = expected.cursor
        && (observation.cursor.column != value.column || observation.cursor.row != value.row)
    {
        return Err(format!(
            "{location} cursor: expected {},{}, got {},{}",
            value.column, value.row, observation.cursor.column, observation.cursor.row
        ));
    }
    if let Some(value) = expected.dimensions
        && (observation.state.columns != value.columns
            || observation.state.rows != value.rows
            || observation.state.width_pixels != value.width_pixels
            || observation.state.height_pixels != value.height_pixels)
    {
        return Err(format!(
            "{location} dimensions: expected {value:?}, got {}x{} {}x{}px",
            observation.state.columns,
            observation.state.rows,
            observation.state.width_pixels,
            observation.state.height_pixels
        ));
    }
    if let Some(value) = expected.scrollbar
        && observation.state.scrollbar != value
    {
        return Err(format!(
            "{location} scrollbar: expected {value:?}, got {:?}",
            observation.state.scrollbar
        ));
    }
    if let Some(value) = expected.kitty_keyboard_flags
        && observation.state.kitty_keyboard_flags != value
    {
        return Err(format!(
            "{location} Kitty keyboard flags: expected {value}, got {}",
            observation.state.kitty_keyboard_flags
        ));
    }
    for assertion in &expected.rows {
        let row = observation
            .rows
            .get(assertion.row)
            .ok_or_else(|| format!("{location} row {} is absent", assertion.row))?;
        if row.wraps_to_next != assertion.wraps_to_next
            || row.is_wrap_continuation != assertion.is_wrap_continuation
        {
            return Err(format!(
                "{location} row {} wrap: expected {assertion:?}, got next={} continuation={}",
                assertion.row, row.wraps_to_next, row.is_wrap_continuation
            ));
        }
    }
    for assertion in &expected.cells {
        let cell = observation
            .rows
            .get(assertion.row)
            .and_then(|row| row.cells.get(assertion.column))
            .ok_or_else(|| {
                format!(
                    "{location} row {} cell {} is absent",
                    assertion.row, assertion.column
                )
            })?;
        if cell.grapheme.base64 != assertion.grapheme_base64 {
            return Err(format!(
                "{location} row {} cell {} grapheme: expected {}, got {}",
                assertion.row, assertion.column, assertion.grapheme_base64, cell.grapheme.base64
            ));
        }
        if let Some(value) = assertion.width
            && cell.width != value
        {
            return Err(format!(
                "{location} row {} cell {} width: expected {value:?}, got {:?}",
                assertion.row, assertion.column, cell.width
            ));
        }
        if let Some(value) = &assertion.style
            && &cell.style != value
        {
            return Err(format!(
                "{location} row {} cell {} style: expected {value:?}, got {:?}",
                assertion.row, assertion.column, cell.style
            ));
        }
    }
    for assertion in &expected.palette {
        let actual = observation.render_colors.palette.get(assertion.index);
        if actual != Some(&assertion.color) {
            return Err(format!(
                "{location} palette {}: expected {:?}, got {actual:?}",
                assertion.index, assertion.color
            ));
        }
    }
    for assertion in &expected.modes {
        let actual = observation
            .modes
            .iter()
            .find(|value| value.number == assertion.number && value.ansi == assertion.ansi);
        if actual.is_none_or(|value| value.enabled != assertion.enabled) {
            return Err(format!(
                "{location} mode {} {}: expected {}, got {:?}",
                if assertion.ansi { "ANSI" } else { "DEC" },
                assertion.number,
                assertion.enabled,
                actual.map(|value| value.enabled)
            ));
        }
    }
    for assertion in &expected.effects {
        let actual = observation.effects.iter().find(|value| {
            value.event_index == assertion.event_index
                && value.callback_index == assertion.callback_index
        });
        if actual.is_none_or(|value| value.bytes.base64 != assertion.base64) {
            return Err(format!(
                "{location} event {} effect {}: expected {}, got {:?}",
                assertion.event_index,
                assertion.callback_index,
                assertion.base64,
                actual.map(|value| value.bytes.base64.as_str())
            ));
        }
    }
    Ok(())
}

fn encode_bytes(bytes: &[u8]) -> EncodedBytes {
    EncodedBytes {
        base64: BASE64.encode(bytes),
        length: bytes.len(),
        sha256: sha256(bytes),
    }
}

fn decode_canonical_base64(value: &str, maximum: usize, label: &str) -> CorpusResult<Vec<u8>> {
    let decoded = BASE64
        .decode(value)
        .map_err(|error| format!("{label} is invalid base64: {error}"))?;
    if decoded.len() > maximum || BASE64.encode(&decoded) != value {
        return Err(format!("{label} is not bounded canonical base64"));
    }
    Ok(decoded)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn copy_corpus_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).expect("temporary corpus directory must be created");
    for entry in fs::read_dir(source).expect("source corpus directory must be readable") {
        let entry = entry.expect("source corpus entry must be readable");
        let target = destination.join(entry.file_name());
        if entry
            .file_type()
            .expect("source corpus metadata must be readable")
            .is_dir()
        {
            copy_corpus_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("source corpus file must copy");
        }
    }
}

#[test]
fn corpus_manifest_accepts_reviewed_fixtures_and_rejects_malformed_inputs() {
    let corpus = load_corpus(&corpus_root()).expect("reviewed corpus must load");
    assert_eq!(corpus.fixtures.len(), 6);

    let mut traversal = corpus.manifest.clone();
    traversal.fixtures[0].bytes.path = "../ascii-styles.bin".into();
    assert!(
        validate_manifest(&traversal)
            .unwrap_err()
            .contains("invalid byte path")
    );

    let mut invalid_hash = corpus.manifest.clone();
    invalid_hash.fixtures[0].bytes.sha256 = "not-a-hash".into();
    assert!(
        validate_manifest(&invalid_hash)
            .unwrap_err()
            .contains("invalid SHA-256")
    );

    let mut dimensions = corpus.manifest.clone();
    dimensions.fixtures[0].initial.columns = HARD_MAX_COLUMNS + 1;
    assert!(
        validate_manifest(&dimensions)
            .unwrap_err()
            .contains("columns")
    );

    let mut duplicate = corpus.manifest.clone();
    duplicate.fixtures[1].id = duplicate.fixtures[0].id.clone();
    assert!(
        validate_manifest(&duplicate)
            .unwrap_err()
            .contains("duplicate fixture id")
    );

    let mut chunks = corpus.manifest.clone();
    let Event::Write { offset, .. } = &mut chunks.fixtures[0].events[0] else {
        panic!("first reviewed event must be a write")
    };
    *offset = 1;
    assert!(
        validate_manifest(&chunks)
            .unwrap_err()
            .contains("malformed chunk schedule")
    );

    let source = fs::read_to_string(corpus_root().join("manifest.json")).unwrap();
    let unknown = source.replacen("\"type\": \"write\"", "\"type\": \"unknown\"", 1);
    assert!(serde_json::from_str::<Manifest>(&unknown).is_err());

    let temporary = tempfile::tempdir().expect("temporary corpus root must be created");
    copy_corpus_tree(&corpus_root(), temporary.path());
    let wrong_hash = source.replacen(
        &corpus.manifest.fixtures[0].bytes.sha256,
        &"0".repeat(64),
        1,
    );
    fs::write(temporary.path().join("manifest.json"), wrong_hash).unwrap();
    assert!(
        load_corpus(temporary.path())
            .unwrap_err()
            .contains("SHA-256 mismatch")
    );
}

#[test]
fn corpus_native_assertions_and_optional_export() {
    let corpus = load_corpus(&corpus_root()).expect("reviewed corpus must load");
    let output = run_corpus(&corpus).expect("native corpus must satisfy hand-authored assertions");
    let json = serde_json::to_vec_pretty(&output).expect("native observation must serialize");
    assert!(json.len() <= corpus.manifest.limits.max_observation_bytes);
    if let Some(path) = env::var_os("YAADE_GHOSTTY_CORPUS_OUTPUT") {
        fs::write(PathBuf::from(path), json)
            .expect("caller-selected native corpus output must write");
    }
}
