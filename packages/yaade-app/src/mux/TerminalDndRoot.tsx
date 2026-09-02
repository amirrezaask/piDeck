import type { ReactNode } from "react";
import { TabDndRoot, type TabDndHandlers } from "@yaade/ui/session";

export type TerminalDndRootProps = {
  readonly handlers: TabDndHandlers;
  readonly children: ReactNode;
};

export default function TerminalDndRoot(props: TerminalDndRootProps) {
  return <TabDndRoot handlers={props.handlers}>{props.children}</TabDndRoot>;
}
