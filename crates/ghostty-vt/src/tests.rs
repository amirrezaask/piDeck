use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::io;

struct CountingAllocator;

thread_local! {
    static TRACK_ALLOCATIONS: Cell<bool> = const { Cell::new(false) };
    static ALLOCATION_COUNT: Cell<usize> = const { Cell::new(0) };
}

// SAFETY: Every operation delegates unchanged to `System`; the thread-local
// counters observe calls but do not alter allocation layout or ownership.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        TRACK_ALLOCATIONS.with(|tracking| {
            if tracking.get() {
                ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
            }
        });
        // SAFETY: The caller provides the GlobalAlloc-required valid layout and
        // ownership is delegated directly to the system allocator.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: The caller returns a pointer/layout pair allocated by this
        // adapter, which delegates exactly to the same system allocator.
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        TRACK_ALLOCATIONS.with(|tracking| {
            if tracking.get() {
                ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
            }
        });
        // SAFETY: The valid layout and resulting ownership follow GlobalAlloc.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        TRACK_ALLOCATIONS.with(|tracking| {
            if tracking.get() {
                ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
            }
        });
        // SAFETY: The pointer/layout originate from this system-backed adapter,
        // and `new_size` follows GlobalAlloc's reallocation contract.
        unsafe { System.realloc(pointer, layout, new_size) }
    }
}

#[global_allocator]
static TEST_ALLOCATOR: CountingAllocator = CountingAllocator;

fn counted_allocations(action: impl FnOnce()) -> usize {
    ALLOCATION_COUNT.with(|count| count.set(0));
    TRACK_ALLOCATIONS.with(|tracking| tracking.set(true));
    action();
    TRACK_ALLOCATIONS.with(|tracking| tracking.set(false));
    ALLOCATION_COUNT.with(Cell::get)
}

use crate::{
    ActiveScreen, CellWidth, ColorScheme, CoordinateSpace, DeviceAttributes, EffectKind,
    EffectLimits, EffectOptions, FormatOptions, GhosttyError, Mode, Rgb, SemanticPrompt, Terminal,
    TerminalOptions, TerminalPoint, TerminalSize, ValueField,
};

fn test_options() -> TerminalOptions {
    TerminalOptions {
        cols: 12,
        rows: 4,
        scrollback: 128,
        effects: EffectOptions {
            limits: EffectLimits::default(),
            size: Some(TerminalSize {
                rows: 4,
                columns: 12,
                cell_width: 8,
                cell_height: 16,
            }),
            color_scheme: Some(ColorScheme::Dark),
            device_attributes: Some(DeviceAttributes::default()),
            enquiry_response: b"yaade".to_vec(),
            xtversion: b"yaade 1".to_vec(),
        },
    }
}

#[test]
fn validates_dimensions_scrollback_and_effect_bounds() {
    for (field, mutate) in [
        (ValueField::Columns, 0usize),
        (ValueField::Columns, usize::from(u16::MAX) + 1),
    ] {
        let mut options = test_options();
        options.cols = mutate;
        assert_eq!(
            Terminal::new(options).err(),
            Some(GhosttyError::InvalidValue { field })
        );
    }

    let mut options = test_options();
    options.rows = 0;
    assert_eq!(
        Terminal::new(options).err(),
        Some(GhosttyError::InvalidValue {
            field: ValueField::Rows
        })
    );

    let mut options = test_options();
    options.scrollback = crate::MAX_SCROLLBACK_ROWS + 1;
    assert_eq!(
        Terminal::new(options).err(),
        Some(GhosttyError::InvalidValue {
            field: ValueField::Scrollback
        })
    );

    let mut options = test_options();
    options.effects.limits.pty_response_bytes = crate::MAX_PTY_RESPONSE_BYTES + 1;
    assert_eq!(
        Terminal::new(options).err(),
        Some(GhosttyError::InvalidValue {
            field: ValueField::PtyResponseBytes
        })
    );
}

#[test]
fn repeated_lifecycle_and_partial_validation_are_safe() -> Result<(), GhosttyError> {
    for iteration in 0..128 {
        let mut terminal = Terminal::new(test_options())?;
        terminal.write(b"plain\r\n\x1b[31mred\x1b[0m")?;
        terminal.write(&[0xff, 0xfe, 0, 0x1b, b'['])?;
        terminal.resize(10 + iteration % 3, 3 + iteration % 2, 8, 16)?;
        terminal.reset();
    }
    Ok(())
}

#[test]
fn callbacks_stage_exact_responses_and_copied_changes() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    let capacities = terminal.callback_capacities();
    {
        let effects = terminal
            .write(b"\x07\x07\x1b]2;build title\x1b\\\x1b]7;file:///tmp/work\x1b\\\x1b[6n")?;
        assert_eq!(effects.bells(), 2);
        assert_eq!(effects.title(), Some(b"build title".as_slice()));
        assert_eq!(
            effects.working_directory(),
            Some(b"file:///tmp/work".as_slice())
        );
        let responses: Vec<Vec<u8>> = effects.pty_responses().map(<[u8]>::to_vec).collect();
        assert_eq!(responses, [b"\x1b[1;1R".to_vec()]);
    }
    assert_eq!(terminal.callback_capacities(), capacities);
    Ok(())
}

#[test]
fn host_queries_use_only_copied_callback_configuration() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    let effects = terminal.write(b"\x05\x1b[>q\x1b[14t\x1b[?996n\x1b[c")?;
    let queries = effects.queries();
    assert_eq!(queries.enquiry, 1);
    assert_eq!(queries.xtversion, 1);
    assert_eq!(queries.size, 1);
    assert_eq!(queries.color_scheme, 1);
    assert_eq!(queries.device_attributes, 1);
    let joined = effects
        .pty_responses()
        .flat_map(|response| response.iter().copied())
        .collect::<Vec<_>>();
    assert!(joined.windows(5).any(|window| window == b"yaade"));
    assert!(joined.windows(7).any(|window| window == b"yaade 1"));
    Ok(())
}

#[test]
fn callback_overflow_is_typed_and_never_silently_drops_query_bytes() {
    let mut options = test_options();
    options.effects.limits.pty_response_bytes = 1;
    let mut terminal = Terminal::new(options).expect("terminal");
    assert!(matches!(
        terminal.write(b"\x1b[6n"),
        Err(GhosttyError::CallbackOverflow {
            effect: EffectKind::PtyResponseBytes,
            limit: 1,
        })
    ));

    let mut options = test_options();
    options.effects.limits.bells = 1;
    let mut terminal = Terminal::new(options).expect("terminal");
    assert!(matches!(
        terminal.write(b"\x07\x07"),
        Err(GhosttyError::CallbackOverflow {
            effect: EffectKind::Bells,
            limit: 1,
        })
    ));

    let mut options = test_options();
    options.effects.limits.text_bytes = 3;
    let mut terminal = Terminal::new(options).expect("terminal");
    assert!(matches!(
        terminal.write(b"\x1b]2;long\x1b\\"),
        Err(GhosttyError::CallbackOverflow {
            effect: EffectKind::Title,
            limit: 3,
        })
    ));
}

#[test]
fn resize_stages_in_band_response_after_native_return() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    terminal.set_mode(Mode::IN_BAND_RESIZE, true)?;
    let effects = terminal.resize(20, 5, 9, 18)?;
    let responses = effects.pty_responses().collect::<Vec<_>>();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0], b"\x1b[48;5;20;90;180t");
    Ok(())
}

#[test]
fn public_state_copies_text_colors_modes_and_scrollback() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    terminal.set_default_colors(
        Some(Rgb { r: 1, g: 2, b: 3 }),
        Some(Rgb { r: 4, g: 5, b: 6 }),
        Some(Rgb { r: 7, g: 8, b: 9 }),
    )?;
    terminal.write(b"\x1b]2;title\x1b\\\x1b]7;/work\x1b\\one\r\ntwo\r\n")?;
    assert!(!terminal.mode(Mode::BRACKETED_PASTE)?);
    terminal.write(b"\x1b[?2004h")?;
    assert!(terminal.mode(Mode::BRACKETED_PASTE)?);

    let state = terminal.state()?;
    assert_eq!(state.columns, 12);
    assert_eq!(state.rows, 4);
    assert_eq!(state.active_screen, ActiveScreen::Primary);
    assert!(!state.alternate_screen);
    assert_eq!(state.title.as_str()?, "title");
    assert_eq!(state.working_directory.as_str()?, "/work");
    assert_eq!(state.colors.foreground, Some(Rgb { r: 1, g: 2, b: 3 }));
    assert_eq!(state.colors.background, Some(Rgb { r: 4, g: 5, b: 6 }));
    assert_eq!(state.colors.cursor, Some(Rgb { r: 7, g: 8, b: 9 }));
    assert_eq!(state.colors.palette.len(), 256);
    Ok(())
}

#[test]
fn render_traversal_handles_wide_combining_empty_and_styles() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    terminal.write("A\x1b[1;3;4;38;2;10;20;30m界e\u{301}\x1b[0m".as_bytes())?;
    let before = terminal.render.grapheme_capacity();
    let mut observed = Vec::new();
    terminal.with_render_state(|render| {
        assert_eq!(render.columns(), 12);
        assert_eq!(render.rows(), 4);
        assert_eq!(render.colors().palette.len(), 256);
        assert_eq!(render.cursor().viewport_position.expect("cursor").row, 0);
        while let Some(mut row) = render.next_row()? {
            if row.index() == 0 {
                assert_eq!(row.semantic_prompt()?, SemanticPrompt::None);
            }
            while let Some(mut cell) = row.next_cell()? {
                let text = cell.grapheme_text()?.to_owned();
                if !text.is_empty() {
                    let style = cell.style()?;
                    observed.push((text, cell.width()?, style));
                }
            }
        }
        Ok(())
    })?;
    assert_eq!(observed[0].0, "A");
    assert_eq!(observed[1].0, "界");
    assert_eq!(observed[1].1, CellWidth::Wide);
    assert!(observed.iter().any(|(text, _, _)| text == "e\u{301}"));
    assert!(observed[1].2.bold);
    assert!(observed[1].2.italic);
    assert!(terminal.render.grapheme_capacity() >= before);
    Ok(())
}

#[test]
fn steady_write_and_render_traversal_reuse_rust_scratch() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    terminal.write(b"warm up")?;
    terminal.with_render_state(|render| {
        while let Some(mut row) = render.next_row()? {
            while let Some(mut cell) = row.next_cell()? {
                let _ = cell.grapheme_bytes()?;
            }
        }
        Ok(())
    })?;

    let allocations = counted_allocations(|| {
        let effects = terminal.write(b"x").expect("steady write");
        assert!(effects.is_empty());
        terminal
            .with_render_state(|render| {
                while let Some(mut row) = render.next_row()? {
                    while let Some(mut cell) = row.next_cell()? {
                        let _ = cell.grapheme_bytes()?;
                    }
                }
                Ok(())
            })
            .expect("steady render traversal");
    });
    assert_eq!(allocations, 0);
    Ok(())
}

#[test]
fn formatter_is_bounded_reused_and_frees_on_sink_error() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    terminal.write(b"hello\r\nworld")?;
    let mut output = Vec::new();
    let written = terminal.format_into(
        FormatOptions {
            unwrap: true,
            trim: true,
            ..FormatOptions::default()
        },
        4096,
        &mut output,
    )?;
    assert_eq!(written, output.len());
    assert!(String::from_utf8_lossy(&output).contains("hello"));
    assert!(matches!(
        terminal.format_into(FormatOptions::default(), 1, &mut Vec::new()),
        Err(GhosttyError::OutOfSpace { .. })
    ));

    struct BrokenSink;
    impl io::Write for BrokenSink {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    assert_eq!(
        terminal.format_into(FormatOptions::default(), 4096, &mut BrokenSink),
        Err(GhosttyError::Sink {
            kind: io::ErrorKind::BrokenPipe
        })
    );
    terminal.write(b"still live")?;
    Ok(())
}

#[test]
fn panic_unwind_releases_borrowed_views_and_native_formatters() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    terminal.write(b"before")?;
    let render_panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = terminal.with_render_state(|render| -> Result<(), GhosttyError> {
            let _row = render.next_row()?.expect("row");
            panic!("visitor failed");
        });
    }));
    assert!(render_panic.is_err());
    terminal.write(b"after")?;

    struct PanicSink;
    impl io::Write for PanicSink {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            panic!("sink failed");
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let formatter_panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = terminal.format_into(FormatOptions::default(), 4096, &mut PanicSink);
    }));
    assert!(formatter_panic.is_err());
    terminal.write(b"still usable")?;
    Ok(())
}

#[test]
fn tracked_grid_refs_are_raii_and_owner_checked() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    terminal.write(b"tracked")?;
    let mut tracked = terminal.track_point(TerminalPoint {
        space: CoordinateSpace::Viewport,
        column: 1,
        row: 0,
    })?;
    assert_eq!(
        tracked.point(CoordinateSpace::Viewport)?,
        Some(TerminalPoint {
            space: CoordinateSpace::Viewport,
            column: 1,
            row: 0,
        })
    );
    terminal.write(b"\r\nmore")?;
    assert!(tracked.has_value());

    let mut other = Terminal::new(test_options())?;
    assert_eq!(
        tracked.set(
            &mut other,
            TerminalPoint {
                space: CoordinateSpace::Viewport,
                column: 0,
                row: 0,
            }
        ),
        Err(GhosttyError::InvalidValue {
            field: ValueField::TerminalOwner
        })
    );
    drop(terminal);
    assert!(!tracked.has_value());
    assert_eq!(tracked.point(CoordinateSpace::Viewport)?, None);
    Ok(())
}

#[test]
fn deterministic_arbitrary_bytes_chunks_and_mutations_do_not_panic() -> Result<(), GhosttyError> {
    let mut terminal = Terminal::new(test_options())?;
    let mut seed = 0x4d59_5df4_d0f3_3173u64;
    let mut corpus = vec![0u8; 32 * 1024];
    for byte in &mut corpus {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        *byte = seed.to_le_bytes()[0];
    }

    let chunks = [1, 2, 3, 7, 16, 31, 127, 1024];
    for (iteration, chunk) in chunks.into_iter().enumerate() {
        for bytes in corpus.chunks(chunk) {
            match terminal.write(bytes) {
                Ok(_effects) => {}
                Err(GhosttyError::CallbackOverflow { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        terminal.resize(1 + iteration, 1 + iteration % 4, 1, 1)?;
        if iteration % 2 == 0 {
            terminal.reset();
        }
    }
    Ok(())
}

#[test]
fn maximum_width_with_one_row_is_supported() -> Result<(), GhosttyError> {
    let mut options = test_options();
    options.cols = usize::from(u16::MAX);
    options.rows = 1;
    options.scrollback = 0;
    let mut terminal = Terminal::new(options)?;
    terminal.write(b"x")?;
    terminal.resize(
        usize::from(u16::MAX),
        1,
        usize::try_from(u32::MAX).expect("supported targets have at least 32-bit usize"),
        1,
    )?;
    assert_eq!(terminal.state()?.columns, u16::MAX);
    Ok(())
}
