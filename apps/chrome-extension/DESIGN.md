# Switcher Design System

## Direction

Switcher is an operating surface, not a destination. It uses an ink-and-graphite command console: dense neutral rows, crisp hierarchy, and almost no decoration. The panel should feel native to focused desktop work while remaining clearly isolated from the host page.

## Color

Light and dark themes share semantic roles. Neutral graphite owns the surface; blue-gray is reserved for focus, red for destructive actions, and amber only for the unassigned-shortcut warning. Backdrop blur is functional separation rather than decoration.

## Typography

Use the local system UI stack. Titles are 14px medium, metadata 12px, and group labels 10px semibold uppercase. Keyboard hints use tabular numerals but not a costume monospace face.

## Shape and elevation

The palette has one 16px outer radius. Rows use an 8px selection radius and stay visually flat until selected. Elevation is a soft downward shadow without a competing decorative border treatment. Small controls may use compact rounded shapes; result rows are never cards.

## Motion

Opening combines a 150ms backdrop fade with an 8px upward settling movement and 1% scale correction. Closing is slightly shorter. Reduced-motion mode removes spatial movement and blur.

## Interaction

The query owns initial focus. The panel opens as a single search field and reveals results plus keyboard guidance only after the user types. Selection is always visible, pointer actions never trigger the row action, and every icon button has an accessible name and tooltip.
