import {
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	lazy,
} from "react";
import { LayoutGroup, LazyMotion, MotionConfig } from "motion/react";
import { Option } from "effect";
import { aside as MotionAside } from "motion/react-m";
import type {
	CreateTerminal,
	SessionId,
	SessionTab,
	SessionTabId,
	TerminalKind,
	MuxTerminal,
	MuxTerminalId,
	TerminalInput,
} from "@yaade/rpc";
import { SessionTabConflict } from "@yaade/rpc";
import type { DropAction, PanelId } from "@yaade/shared";
import type { PanelEvent } from "@yaade/panels";
import {
	Alert,
	AlertDescription,
	AlertTitle,
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Sidebar,
	SidebarHeader,
	SidebarProvider,
	SidebarTrigger,
	Spinner,
	TooltipProvider,
} from "@yaade/ui/primitives";
import {
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
	Plus,
	ListFilter,
	Settings,
	X,
} from "lucide-react";
import {
	AmbientCanvas,
	WhichKeyPanel,
	cn,
	useIsMobile,
	yaadeMotion,
	type TabDndHandlers,
} from "@yaade/ui/session";
import {
	focusRegisteredTerminal,
	jumpRegisteredTerminalToLive,
	readTerminalViewportActivity,
	toggleRegisteredTerminalInspectionPause,
} from "@yaade/ui/terminal-registry";
import { TerminalSurfacePlacement } from "@yaade/ui/terminal";
import type { KeyboardCapture, KeyboardSettingsModel } from "@yaade/ui/settings";
import { CHORD_TIMEOUT_MS } from "@yaade/workspace";
import { bundledThemeList } from "@yaade/ui/appearance";
import type { ProcessTerminalViewProps } from "./renderers/TerminalView.js";
import {
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	useAppearanceSettings,
} from "../hooks/useAppearanceSettings.js";
import { useKeymapSettings } from "../hooks/useKeymapSettings.js";
import { bindingFromKeyboardEvent } from "../keymap-profile.js";
import { isDesktopClient, isMacDesktopClient } from "../client-environment.js";

import { createTerminalClient, type MuxClient } from "./mux-client.js";
import { useHostPorts } from "../host-ports.js";
import { useServerConnections } from "../server-connections.js";
import {
	chooseSession,
	chooseTab,
	chooseMuxTerminal,
	isLiveSessionTab,
	persistMuxSessionRoute,
	parseMuxSessionRoute,
	resolveMuxSessionRoute,
	sameLocalResource,
	shouldHoldRequestedRoute,
	muxSessionUrl,
} from "./mux-routing.js";
import { SessionTabStrip } from "./SessionTabStrip.js";
import { SessionWindowTabStrip } from "./SessionWindowTabStrip.js";
import { SessionSwitcher } from "./SessionSwitcher.js";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import { TerminalTabStrip } from "./TerminalTabStrip.js";
import { SidebarResizeHandle } from "./SidebarResizeHandle.js";
import {
	muxTerminalWorkTitle,
	nextRuntimeTerminalTitle,
	type RuntimeTerminalTitle,
} from "./terminal-title.js";
import { SessionLoadingState } from "./SessionEmptyState.js";
import {
	MAX_TERMINAL_TILES,
	closeTerminalPanel,
	createTerminalWorkspace,
	dockTerminalView,
	focusTerminalPanel,
	openTerminalView,
	openTerminalViewInPanel,
	removeMissingTerminalViews,
	reorderTerminalTabs,
	resizeTerminalSplit,
	restoreTerminalWorkspace,
	serializeTerminalWorkspace,
	splitTerminalPanel,
	toggleTerminalPanelZoom,
	terminalIdsInWorkspace,
	terminalPaneCount,
	type TerminalWorkspace,
} from "./terminal-tiling.js";
import {
	muxSessionDirectShortcutFor,
	muxSessionPrimaryShortcutFor,
	muxSessionShortcutFor,
} from "./mux-keymap.js";
import {
	DEFAULT_KEYMAP_CATALOG,
	MUX_SESSION_PREFIX_GROUPS,
	clearMuxSessionKeymapState,
	createMuxSessionKeymapState,
	decodeMuxSessionCommand,
	isMuxSessionJumpKey,
	matchMuxSessionPrefixBinding,
	resolveMuxSessionKeydown,
	muxSessionHudBindings,
	muxSessionLeader,
	isMuxSessionCommand,
	type MuxSessionKeydownContext,
} from "../keybindings.js";
import {
	createCommandRuntime,
	type CommandHandlers,
	type CommandRuntime,
} from "../commands/runtime.js";
import {
	COMMAND_CATALOG,
	commandCategoryLabel,
	type CommandAvailabilityKey,
} from "../commands/catalog.js";
import {
	loadTerminalFocusHistory,
	saveTerminalFocusHistory,
	terminalFocusIdentityKey,
} from "./terminal-focus-history.js";
import type { TerminalSwitcherSourceEntry } from "./terminal-switcher-model.js";

const SettingsOverlay = lazy(() => import("@yaade/ui/settings"));
const TerminalSwitcher = lazy(() =>
	import("./TerminalSwitcher.js").then(({ TerminalSwitcher: View }) => ({
		default: View,
	})),
);
const CommandPalette = lazy(() =>
	import("./CommandPalette.js").then(({ CommandPalette: View }) => ({
		default: View,
	})),
);
const MobileTerminalView = lazy(() =>
	import("./MobileTerminalView.js").then(({ MobileTerminalView: View }) => ({
		default: View,
	})),
);
const TerminalDndRoot = lazy(() => import("./TerminalDndRoot.js"));
const TerminalTilingWorkspace = lazy(() => import("./TerminalTilingWorkspace.js"));
const TerminalRenderer = lazy(() =>
	import("./renderers/TerminalView.js").then(({ ProcessTerminalView }) => ({
		default: ProcessTerminalView,
	})),
);
const loadMotionFeatures = () => import("motion/react").then(({ domMax }) => domMax);
const EMPTY_TERMINAL_IDS: readonly MuxTerminalId[] = [];

type MuxSessionHistoryState = { readonly yaadeMobileTerminal?: string } | null;

function writeMuxSessionLocation(
	url: string,
	mode: "push" | "replace",
	state: MuxSessionHistoryState = null,
): void {
	persistMuxSessionRoute(url, localStorage);
	if (mode === "push") history.pushState(state, "", url);
	else history.replaceState(state, "", url);
}
const EMPTY_TAB_IDS: readonly SessionTabId[] = [];

type CloseChoice = { readonly sessionId: SessionId } | undefined;

function commandContextLabel(availability: CommandAvailabilityKey): string {
	switch (availability) {
		case "always": return "Global"
		case "activeSession": return "Active session"
		case "activeTab": return "Active Window"
		case "activeTerminal": return "Focused terminal"
		case "anyTerminal": return "Any terminal"
		case "multipleTabs": return "Multiple Windows"
		case "multipleTerminals": return "Multiple terminals in Window"
		case "multipleAvailableTerminals": return "Multiple terminals"
		case "sidebarLayout": return "Sidebar layout"
		case "viewportNotLive": return "Terminal scrollback"
		case "viewportPausable": return "Scrollable terminal"
	}
}

function terminalHasResidentSurface(terminal: MuxTerminal): boolean {
	return Boolean(
		terminal.output.ptyId ||
			(terminal.output.processState === "interrupted" &&
				terminal.output.replayAvailable &&
				terminal.output.historyId),
	);
}

function keymapDiagnosticLabel(diagnostic: string | undefined): string | undefined {
	switch (diagnostic) {
		case "invalid-storage":
			return "The stored keymap was invalid, so defaults are active."
		case "newer-version":
			return "The stored keymap needs a newer YAADE version, so defaults are active."
		case "oversized":
			return "The stored keymap exceeded the 32 KiB limit, so defaults are active."
		case "compile-conflict":
			return "The stored keymap conflicted with current commands, so defaults are active."
		case "storage-denied":
			return "Browser storage is unavailable. Keymap changes apply only to this tab."
		default:
			return undefined
	}
}

type TerminalOpenTarget = {
	readonly sessionId: SessionId;
	readonly tabId: SessionTabId;
	readonly panelId: PanelId;
};

function CommandPaletteTrigger(props: {
	readonly onOpen: () => void;
	readonly side: "bottom" | "right";
	readonly size?: "icon-xs" | "icon-sm";
	readonly className?: string;
}) {
	return (
		<ShortcutTooltip
			label="Commands"
			shortcut={muxSessionShortcutFor("commandPalette.show")}
			side={props.side}
		>
			<Button
				type="button"
				size={props.size ?? "icon-sm"}
				variant="ghost"
				aria-label="Commands"
				title="Commands"
				data-yaade-command-palette-trigger="desktop"
				className={props.className}
				onClick={props.onOpen}
			>
				<ListFilter />
			</Button>
		</ShortcutTooltip>
	);
}

function PrefixHud(props: { readonly onSelect: (key: string) => void }) {
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center px-2">
			<div className="pointer-events-auto w-full max-w-4xl">
				<WhichKeyPanel
					variant="overlay"
					prefix={muxSessionLeader()}
					groups={MUX_SESSION_PREFIX_GROUPS}
					entries={muxSessionHudBindings().map((binding) => ({
						key: binding.key,
						desc: binding.desc,
						group: binding.group,
					}))}
					onSelect={props.onSelect}
				/>
			</div>
		</div>
	);
}

function isLive(terminal: MuxTerminal): boolean {
	return (
		terminal.status === "created" ||
		terminal.status === "starting" ||
		terminal.status === "running" ||
		terminal.status === "waiting"
	);
}

function sessionStatusLabel(terminals: readonly MuxTerminal[]): string {
	if (terminals.length === 0) return "No terminals";
	if (
		terminals.some(
			(terminal) =>
				terminal.status === "failed" ||
				(terminal.output.kind === "process" && terminal.output.activityState === "failed"),
		)
	) {
		return "Failed";
	}
	if (
		terminals.some(
			(terminal) =>
				terminal.status === "waiting" ||
				(terminal.output.kind === "process" &&
					terminal.output.activityState === "waiting_for_input"),
		)
	) {
		return "Waiting";
	}
	if (
		terminals.some(
			(terminal) =>
				terminal.output.kind === "process" &&
				(terminal.output.activityState === "working" ||
					terminal.output.activityState === "running_command"),
		)
	) {
		return "Working";
	}
	if (terminals.some((terminal) => terminal.status === "starting")) return "Starting";
	if (terminals.some((terminal) => isLive(terminal))) return "Running";
	return "Idle";
}

function firstEmptyTerminalPanel(workspace: TerminalWorkspace): PanelId | undefined {
	let emptyPanel: PanelId | undefined;
	workspace.tree.visitLeaves((leaf) => {
		if (!emptyPanel && leaf.view.kind === "empty") {
			emptyPanel = leaf.panelId;
		}
	});
	return emptyPanel;
}

function errorMessage<T>(error: T): string {
	return error instanceof Error ? error.message : "The host could not complete that action.";
}

function nextWindowTitle(tabs: readonly SessionTab[]): string {
	const usedTitles = new Set(tabs.map((tab) => tab.title));
	let index = 1;
	while (usedTitles.has(`Window ${index}`)) index += 1;
	return `Window ${index}`;
}

function markPerformance(name: string): void {
	try {
		const start = `${name}:start`;
		const end = `${name}:end`;
		performance.clearMarks(start);
		performance.clearMarks(end);
		performance.clearMeasures(name);
		performance.mark(start);
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				performance.mark(end);
				try {
					performance.measure(name, start, end);
				} catch {
					/* ignore */
				}
			});
		});
	} catch {
		/* ignore unsupported environments */
	}
}

export function TerminalMultiplexer() {
	const hostPorts = useHostPorts();
	const serverConnections = useServerConnections();
	const desktopClient = isDesktopClient(window.location);
	const macDesktopClient = isMacDesktopClient(window.location, window.navigator);
	const { activeTheme, appearanceSettings, resetAppearanceSettings, setAppearanceSettings } =
		useAppearanceSettings();
	const keymapSettings = useKeymapSettings();
	const { resetKeymap } = keymapSettings;
	const [terminalFocusHistory] = useState(
		() => loadTerminalFocusHistory().history,
	);
	const [client] = useState<MuxClient>(() => createTerminalClient({ api: hostPorts.mux }));
	const snapshot = useSyncExternalStore(
		client.store.subscribe,
		client.store.getSnapshot,
		client.store.getSnapshot,
	);
	const [closeChoice, setCloseChoice] = useState<CloseChoice>();
	const [actionError, setActionError] = useState<string | undefined>();
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [muxTerminalSwitcherOpen, setTerminalSwitcherOpen] = useState(false);
	const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [paneChromeOverlayOpen, setPaneChromeOverlayOpen] = useState(false);
	const [routeRevision, setRouteRevision] = useState(0);
	const [terminalWorkspaces, setTerminalWorkspaces] = useState<
		ReadonlyMap<SessionTabId, TerminalWorkspace>
	>(() => new Map());
	const [residentTerminalIds, setResidentTerminalIds] = useState<ReadonlySet<MuxTerminalId>>(
		() => new Set(),
	);
	const [prefixPending, setPrefixPending] = useState(false);
	const [runtimeTitles, setRuntimeTitles] = useState<
		ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>
	>(() => new Map());
	const layoutSaveTails = useRef(new Map<SessionTabId, Promise<void>>());
	const layoutServerStateRef = useRef(
		new Map<SessionTabId, { revision: number; layoutJson?: string }>(),
	);
	const keymapStateRef = useRef(createMuxSessionKeymapState());
	const prefixTimerRef = useRef<number | undefined>(undefined);
	const prefixStartedInTerminalRef = useRef(false);
	const pendingTerminalPanelRequestsRef = useRef(new Set<string>());
	const closingTabIdsRef = useRef(new Set<SessionTabId>());
	const navigationIntentRef = useRef(0);
	const pendingFocusHistoryRef = useRef(new Set<MuxTerminalId>());
	const muxTerminalsRef = useRef(snapshot.terminalsById);
	const focusedMuxTerminalRef = useRef<MuxTerminal | undefined>(undefined);
	const overlayWasOpenRef = useRef(false);
	const isMobile = useIsMobile();
	muxTerminalsRef.current = snapshot.terminalsById;

	useEffect(() => {
		client.start();
		void client.hydrate().catch(() => undefined);
		return () => client.dispose();
	}, [client]);

	useEffect(() => {
		const bridge = window.__yaadeTest;
		if (!bridge) return;
		const previous = bridge.waitForReady.bind(bridge);
		bridge.waitForReady = async () => {
			await previous();
			await new Promise<void>((resolve, reject) => {
				const timeout = window.setTimeout(() => {
					unsubscribe();
					reject(new Error("timed out waiting for host hydrate"));
				}, 30_000);
				const ready = (): boolean => {
					const snap = client.store.getSnapshot();
					if (snap.connection !== "connected") return false;
					const route = parseMuxSessionRoute(location.href);
					if (route.sessionId) {
						const present = [...snap.sessionsById.keys()].some((id) =>
							sameLocalResource(id, route.sessionId),
						);
						if (present) return sameLocalResource(snap.activeSessionId, route.sessionId);
					}
					if (route.muxTerminalId) {
						const present = [...snap.terminalsById.keys()].some((id) =>
							sameLocalResource(id, route.muxTerminalId),
						);
						if (present) return sameLocalResource(snap.activeMuxTerminalId, route.muxTerminalId);
					}
					return true;
				};
				const unsubscribe = client.store.subscribe(() => {
					if (!ready()) return;
					window.clearTimeout(timeout);
					unsubscribe();
					resolve();
				});
				if (ready()) {
					window.clearTimeout(timeout);
					unsubscribe();
					resolve();
				}
			});
		};
		return () => {
			bridge.waitForReady = previous;
		};
	}, [client]);

	useEffect(() => {
		if (serverConnections.snapshot.generation === 0) return;
		const activeId = serverConnections.snapshot.activeServerId;
		const current =
			serverConnections.snapshot.connections.find((connection) => connection.id === activeId) ??
			serverConnections.snapshot.connections[0];
		if (
			current?.status === "offline" ||
			current?.status === "incompatible" ||
			current?.status === "revoked"
		) {
			return;
		}
		void client.reconcile().catch(() => undefined);
	}, [
		client,
		serverConnections.snapshot.generation,
		serverConnections.snapshot.connections,
		serverConnections.snapshot.activeServerId,
	]);

	useEffect(() => {
		const activeId = serverConnections.snapshot.activeServerId;
		const current =
			serverConnections.snapshot.connections.find((connection) => connection.id === activeId) ??
			serverConnections.snapshot.connections[0];
		if (!current) return;
		if (
			current.status === "offline" ||
			current.status === "incompatible" ||
			current.status === "revoked"
		) {
			client.store.setConnection("offline");
			return;
		}
		if (
			current.status === "synchronizing" ||
			current.status === "connecting" ||
			current.status === "authenticating"
		) {
			client.store.setConnection("reconciling");
			return;
		}
		if (current.status === "connected") {
			void client.reconcile().catch(() => undefined);
		}
	}, [client, serverConnections.snapshot]);

	useEffect(() => {
		const onPopState = () => setRouteRevision((revision) => revision + 1);
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	useEffect(() => {
		const route = resolveMuxSessionRoute(location.href, localStorage);
		if (shouldHoldRequestedRoute(route, snapshot, snapshot.connection)) {
			return;
		}
		const requestedTerminal = route.muxTerminalId
			? (snapshot.terminalsById.get(route.muxTerminalId) ??
				[...snapshot.terminalsById.values()].find((terminal) =>
					sameLocalResource(terminal.id, route.muxTerminalId),
				))
			: undefined;
		const requestedSessionId = route.sessionId ?? requestedTerminal?.sessionId;
		const sessions = [...snapshot.sessionsById.values()];
		const session = requestedSessionId
			? chooseSession(requestedSessionId, sessions)
			: chooseSession(undefined, sessions);
		if (!session) return;
		if (requestedSessionId && !sameLocalResource(session.id, requestedSessionId)) return;
		const tabs = snapshot.visibleTabIdsBySession.get(session.id) ?? [];
		const tab = chooseTab(
			route.tabId,
			session,
			tabs
				.map((id) => snapshot.tabsById.get(id))
				.filter((value): value is SessionTab => Boolean(value)),
			requestedTerminal?.sessionId === session.id ? requestedTerminal.tabId : undefined,
		);
		const ids = tab ? (snapshot.terminalIdsByTab.get(tab.id) ?? []) : EMPTY_TERMINAL_IDS;
		const mobileListRoute = isMobile && !route.muxTerminalId;
		const terminalId = mobileListRoute
			? undefined
			: chooseMuxTerminal(route.muxTerminalId, tab, ids);
		if (snapshot.activeSessionId !== session.id) {
			serverConnections.manager.selectSession(session.id);
			client.store.selectSession(session.id);
		}
		if (tab && snapshot.activeTabId !== tab.id) {
			serverConnections.manager.selectTab(tab.id);
			client.store.selectTab(tab.id);
		}
		if (terminalId && snapshot.activeMuxTerminalId !== terminalId) {
			serverConnections.manager.selectMuxTerminal(terminalId);
			client.store.selectMuxTerminal(terminalId);
		}
		const url = muxSessionUrl(session.id, tab?.id, terminalId);
		persistMuxSessionRoute(url, localStorage);
		if (location.href !== new URL(url, location.origin).href) history.replaceState(null, "", url);
	}, [
		client,
		snapshot.activeSessionId,
		snapshot.activeTabId,
		snapshot.activeMuxTerminalId,
		snapshot.sessionsById,
		snapshot.tabsById,
		snapshot.terminalsById,
		snapshot.visibleTabIdsBySession,
		snapshot.terminalIdsByTab,
		snapshot.connection,
		routeRevision,
		isMobile,
		serverConnections.manager,
	]);

	const visibleSessions = useMemo(
		() =>
			snapshot.visibleSessionIds
				.map((id) => snapshot.sessionsById.get(id))
				.filter((session): session is NonNullable<typeof session> => Boolean(session)),
		[snapshot.sessionsById, snapshot.visibleSessionIds],
	);
	const serverNamesBySessionId = useMemo(() => {
		const names = new Map<SessionId, string>();
		for (const session of visibleSessions) {
			const server = serverConnections.manager.serverForSession(session.id);
			if (server) names.set(session.id, server.name);
		}
		return names;
	}, [serverConnections.manager, visibleSessions]);
	const activeSession = snapshot.activeSessionId
		? snapshot.sessionsById.get(snapshot.activeSessionId)
		: undefined;
	const activeTab = snapshot.activeTabId ? snapshot.tabsById.get(snapshot.activeTabId) : undefined;
	const activeSessionId = activeSession?.id;
	const activeTabId = activeTab?.id;
	useEffect(() => {
		const title = [activeTab?.title, activeSession?.title, "YAADE"].filter(Boolean).join(" — ");
		document.title = title;
		if (!desktopClient) return;
		let cancelled = false;
		void import("@tauri-apps/api/window")
			.then(({ getCurrentWindow }) => {
				if (!cancelled) return getCurrentWindow().setTitle(title);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [activeSession?.title, activeTab?.title, desktopClient]);
	const tabIds = useMemo(
		() =>
			activeSessionId
				? (snapshot.visibleTabIdsBySession.get(activeSessionId) ?? EMPTY_TAB_IDS)
				: EMPTY_TAB_IDS,
		[activeSessionId, snapshot.visibleTabIdsBySession],
	);
	const visibleTabs = useMemo(
		() =>
			tabIds
				.map((id) => snapshot.tabsById.get(id))
				.filter((tab): tab is SessionTab => Boolean(tab)),
		[snapshot.tabsById, tabIds],
	);
	const terminalIds = useMemo(
		() =>
			activeTabId
				? (snapshot.terminalIdsByTab.get(activeTabId) ?? EMPTY_TERMINAL_IDS)
				: EMPTY_TERMINAL_IDS,
		[activeTabId, snapshot.terminalIdsByTab],
	);
	const dockTerminalIdsByTab = useMemo(() => {
		const result = new Map<SessionTabId, MuxTerminalId>();
		for (const tab of visibleTabs) {
			const ids = snapshot.terminalIdsByTab.get(tab.id) ?? EMPTY_TERMINAL_IDS;
			const terminalId =
				tab.activeMuxTerminalId && ids.includes(tab.activeMuxTerminalId)
					? tab.activeMuxTerminalId
					: ids[0];
			if (terminalId) result.set(tab.id, terminalId);
		}
		return result;
	}, [snapshot.terminalIdsByTab, visibleTabs]);
	const sessionTitlesById = useMemo(() => {
		const titles = new Map<SessionId, string>();
		for (const session of visibleSessions) titles.set(session.id, session.title);
		return titles;
	}, [visibleSessions]);
	const terminalCounts = useMemo(() => {
		const counts = new Map<SessionId, number>();
		for (const [id, ids] of snapshot.terminalIdsBySession) counts.set(id, ids.length);
		return counts;
	}, [snapshot.terminalIdsBySession]);
	const sessionStatusById = useMemo(() => {
		const statuses = new Map<SessionId, string>();
		for (const session of visibleSessions) {
			const terminals = (snapshot.terminalIdsBySession.get(session.id) ?? EMPTY_TERMINAL_IDS)
				.map((id) => snapshot.terminalsById.get(id))
				.filter((terminal): terminal is MuxTerminal => Boolean(terminal));
			statuses.set(session.id, sessionStatusLabel(terminals));
		}
		return statuses;
	}, [snapshot.terminalIdsBySession, snapshot.terminalsById, visibleSessions]);
	const selected = snapshot.activeMuxTerminalId
		? snapshot.terminalsById.get(snapshot.activeMuxTerminalId)
		: undefined;
	const terminalSwitcherEntries = useMemo<readonly TerminalSwitcherSourceEntry[]>(() => {
		const serverPositions = new Map(
			serverConnections.snapshot.connections.map((connection, index) => [connection.id, index]),
		);
		const tabIdsByTerminal = new Map<MuxTerminalId, SessionTabId>();
		for (const [tabId, ids] of snapshot.terminalIdsByTab) {
			for (const terminalId of ids) tabIdsByTerminal.set(terminalId, tabId);
		}
		const entries: TerminalSwitcherSourceEntry[] = [];
		for (const terminal of snapshot.terminalsById.values()) {
			if (terminal.archivedAt) continue;
			const session = snapshot.sessionsById.get(terminal.sessionId);
			if (!session || session.archivedAt) continue;
			const tabId = terminal.tabId ?? tabIdsByTerminal.get(terminal.id);
			const tab = tabId ? snapshot.tabsById.get(tabId) : undefined;
			if (!tab || tab.archivedAt) continue;
			const server = serverConnections.manager.serverForSession(session.id);
			const serverId = server?.id ?? "current-host";
			entries.push({
				identity: {
					serverId,
					sessionId: session.id,
					tabId: tab.id,
					terminalId: terminal.id,
					generation: terminal.output.generation,
				},
				terminal,
				session,
				tab,
				serverName: server?.name ?? "This server",
				serverPosition: serverPositions.get(serverId) ?? Number.MAX_SAFE_INTEGER,
				title: muxTerminalWorkTitle(terminal, runtimeTitles.get(terminal.id)),
			});
		}
		return entries;
	}, [
		runtimeTitles,
		serverConnections.manager,
		serverConnections.snapshot.connections,
		snapshot.sessionsById,
		snapshot.tabsById,
		snapshot.terminalIdsByTab,
		snapshot.terminalsById,
	]);
	const terminalFocusIdentities = useMemo(
		() => terminalSwitcherEntries.map((entry) => entry.identity),
		[terminalSwitcherEntries],
	);
	useEffect(() => {
		const connections = serverConnections.snapshot.connections;
		if (connections.length === 0) return;
		const configured = new Set(connections.map((connection) => connection.id));
		const authoritative = new Set(
			connections
				.filter((connection) => connection.status === "connected")
				.map((connection) => connection.id),
		);
		const retainedUnavailable = terminalFocusHistory.toProfile().entries.filter(
			(identity) =>
				configured.has(identity.serverId) && !authoritative.has(identity.serverId),
		);
		if (terminalFocusHistory.prune([...terminalFocusIdentities, ...retainedUnavailable])) {
			saveTerminalFocusHistory(terminalFocusHistory);
		}
	}, [
		serverConnections.snapshot.connections,
		terminalFocusHistory,
		terminalFocusIdentities,
	]);
	const terminalSwitcherEntriesRef = useRef(terminalSwitcherEntries);
	terminalSwitcherEntriesRef.current = terminalSwitcherEntries;
	const recordTerminalFocus = useCallback(
		(terminal: MuxTerminal) => {
			const entry = terminalSwitcherEntriesRef.current.find(
				(item) =>
					item.terminal.id === terminal.id &&
					item.identity.generation === terminal.output.generation,
			);
			if (entry && terminalFocusHistory.recordFocus(entry.identity)) {
				saveTerminalFocusHistory(terminalFocusHistory);
			}
		},
		[terminalFocusHistory],
	);
	const recordPlacedTerminalFocus = useCallback(
		(terminalId: string) => {
			const terminal = terminalSwitcherEntriesRef.current.find(
				(entry) => entry.terminal.id === terminalId,
			)?.terminal;
			if (!terminal || !pendingFocusHistoryRef.current.delete(terminal.id)) return;
			recordTerminalFocus(terminal);
		},
		[recordTerminalFocus],
	);
	const twoSidebarLayout = appearanceSettings.sessionLayout === "two-sidebars";
	const singleSidebarLayout = appearanceSettings.sessionLayout === "single-sidebar";
	const sidebarLayout = twoSidebarLayout || singleSidebarLayout;
	const sidebarsCollapsed = sidebarLayout && appearanceSettings.sidebarCollapsed;
	const sidebarOrientation = isMobile ? "horizontal" : "vertical";
	const toggleSidebars = useCallback(() => {
		setAppearanceSettings((previous) => ({
			...previous,
			sidebarCollapsed: !previous.sidebarCollapsed,
		}));
	}, [setAppearanceSettings]);
	const setSidebarOpen = useCallback(
		(open: boolean) => {
			setAppearanceSettings((previous) => ({
				...previous,
				sidebarCollapsed: !open,
			}));
		},
		[setAppearanceSettings],
	);

	const resizeSidebar = useCallback(
		(width: number) => {
			setAppearanceSettings((previous) => ({
				...previous,
				sidebarWidth: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width)),
			}));
		},
		[setAppearanceSettings],
	);

	const updateRuntimeTitle = useCallback(
		(terminal: MuxTerminal, title: string, source: RuntimeTerminalTitle["source"]) => {
			setRuntimeTitles((previous) => {
				const current = previous.get(terminal.id);
				const next = nextRuntimeTerminalTitle(terminal, current, title, source);
				if (!next || (current?.title === next.title && current.source === next.source)) {
					return previous;
				}
				return new Map(previous).set(terminal.id, next);
			});
		},
		[],
	);

	useEffect(() => {
		setTerminalWorkspaces((previous) => {
			const next = new Map(previous);
			let changed = false;
			for (const tabId of tabIds) {
				if (next.has(tabId)) continue;
				const tab = snapshot.tabsById.get(tabId);
				if (!tab) continue;
				const ids = snapshot.terminalIdsByTab.get(tab.id) ?? EMPTY_TERMINAL_IDS;
				next.set(tab.id, restoreTerminalWorkspace(tab.layoutJson, ids));
				changed = true;
			}
			return changed ? next : previous;
		});
	}, [snapshot.tabsById, snapshot.terminalIdsByTab, tabIds]);

	// YAADE terminal client keeps layout authoritative on the host. Adopt a remote layout event
	// only when the local workspace still matches the last server layout; a
	// genuinely dirty local workspace remains visible and is resolved by the
	// revision-checked save path instead of being silently discarded.
	useEffect(() => {
		const replacements = new Map<
			SessionTabId,
			{ expected: TerminalWorkspace; next: TerminalWorkspace }
		>();
		for (const tabId of tabIds) {
			const tab = snapshot.tabsById.get(tabId);
			const workspace = tab ? terminalWorkspaces.get(tab.id) : undefined;
			if (!tab) continue;
			const previousServer = layoutServerStateRef.current.get(tab.id);
			const localJson = workspace ? serializeTerminalWorkspace(workspace) : undefined;
			const serverChanged = Boolean(
				previousServer &&
				(previousServer.revision !== (tab.revision ?? 0) ||
					previousServer.layoutJson !== tab.layoutJson),
			);
			if (
				workspace &&
				previousServer &&
				serverChanged &&
				localJson === previousServer.layoutJson &&
				localJson !== tab.layoutJson
			) {
				const ids = snapshot.terminalIdsByTab.get(tab.id) ?? EMPTY_TERMINAL_IDS;
				replacements.set(tab.id, {
					expected: workspace,
					next: restoreTerminalWorkspace(tab.layoutJson, ids),
				});
			}
			layoutServerStateRef.current.set(tab.id, {
				revision: tab.revision ?? 0,
				...(tab.layoutJson === undefined ? {} : { layoutJson: tab.layoutJson }),
			});
		}
		if (replacements.size === 0) return;
		setTerminalWorkspaces((previous) => {
			const next = new Map(previous);
			let changed = false;
			for (const [tabId, replacement] of replacements) {
				if (previous.get(tabId) !== replacement.expected) continue;
				next.set(tabId, replacement.next);
				changed = true;
			}
			return changed ? next : previous;
		});
	}, [snapshot.tabsById, snapshot.terminalIdsByTab, tabIds, terminalWorkspaces]);

	const updateTerminalWorkspace = useCallback(
		(tabId: SessionTabId, update: (workspace: TerminalWorkspace) => TerminalWorkspace) => {
			setTerminalWorkspaces((previous) => {
				const current = previous.get(tabId) ?? createTerminalWorkspace();
				const next = update(current);
				if (next === current && previous.has(tabId)) return previous;
				return new Map(previous).set(tabId, next);
			});
		},
		[],
	);

	const splitFocusedTerminalPanel = useCallback(
		(edge: "right" | "bottom") => {
			if (!activeTabId) return;
			updateTerminalWorkspace(activeTabId, (workspace) =>
				splitTerminalPanel(workspace, workspace.focusedPanelId, edge),
			);
		},
		[activeTabId, updateTerminalWorkspace],
	);

	const openTerminalInWorkspace = useCallback(
		(terminal: MuxTerminal, target?: TerminalOpenTarget) => {
			const current = client.store.getSnapshot();
			const tabId =
				target?.tabId ??
				terminal.tabId ??
				current.sessionsById.get(terminal.sessionId)?.activeTabId ??
				current.visibleTabIdsBySession.get(terminal.sessionId)?.[0] ??
				activeTabId;
			if (!tabId) return;
			updateTerminalWorkspace(tabId, (workspace) =>
				target?.panelId === undefined
					? openTerminalView(workspace, terminal.id)
					: openTerminalViewInPanel(workspace, target.panelId, terminal.id),
			);
		},
		[activeTabId, client, updateTerminalWorkspace],
	);

	const selectSession = useCallback(
		(id: SessionId) => {
			navigationIntentRef.current += 1;
			markPerformance("yaade:session-switch");
			serverConnections.manager.selectSession(id);
			client.store.selectSession(id);
			const session = client.store.getSnapshot().sessionsById.get(id);
			const nextTab = session?.activeTabId
				? client.store.getSnapshot().tabsById.get(session.activeTabId)
				: undefined;
			writeMuxSessionLocation(
				session ? muxSessionUrl(session.id, nextTab?.id, nextTab?.activeMuxTerminalId) : "/",
				"push",
			);
		},
		[client, serverConnections.manager],
	);

	const selectTerminal = useCallback(
		(terminal: MuxTerminal, target?: TerminalOpenTarget) => {
			navigationIntentRef.current += 1;
			pendingFocusHistoryRef.current.clear();
			pendingFocusHistoryRef.current.add(terminal.id);
			markPerformance("yaade:terminal-switch");
			openTerminalInWorkspace(terminal, target);
			const current = client.store.getSnapshot().activeMuxTerminalId;
			serverConnections.manager.selectMuxTerminal(terminal.id);
			client.store.selectMuxTerminal(terminal.id);
			const tabId = terminal.tabId ?? client.store.getSnapshot().activeTabId;
			const nextUrl = muxSessionUrl(terminal.sessionId, tabId, terminal.id);
			if (current !== terminal.id || location.href !== new URL(nextUrl, location.origin).href) {
				writeMuxSessionLocation(nextUrl, "push", { yaadeMobileTerminal: terminal.id });
			}
		},
		[client, openTerminalInWorkspace, serverConnections.manager],
	);

	const switchToPreviousTerminal = useCallback(() => {
		const currentId = client.store.getSnapshot().activeMuxTerminalId;
		const current = terminalSwitcherEntries.find((entry) => entry.terminal.id === currentId);
		const previous = terminalFocusHistory.previous(
			current?.identity ?? null,
			terminalFocusIdentities,
		);
		if (!previous) return;
		const targetKey = terminalFocusIdentityKey(previous);
		const target = terminalSwitcherEntries.find(
			(entry) => terminalFocusIdentityKey(entry.identity) === targetKey,
		);
		if (target) selectTerminal(target.terminal);
	}, [
		client,
		selectTerminal,
		terminalFocusHistory,
		terminalFocusIdentities,
		terminalSwitcherEntries,
	]);

	const lastAutoOpenedTerminalRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!selected) return;
		const key = `${selected.sessionId}:${selected.id}`;
		if (lastAutoOpenedTerminalRef.current === key) return;
		lastAutoOpenedTerminalRef.current = key;
		openTerminalInWorkspace(selected);
	}, [openTerminalInWorkspace, selected]);

	useEffect(() => {
		if (!activeTabId) return;
		const liveIds = new Set(terminalIds);
		updateTerminalWorkspace(activeTabId, (workspace) =>
			removeMissingTerminalViews(workspace, liveIds),
		);
	}, [activeTabId, updateTerminalWorkspace, terminalIds]);

	const createTerminal = useCallback(
		async (
			nextKind: TerminalKind = "terminal",
			targetSessionId?: SessionId,
			target?: TerminalOpenTarget,
		): Promise<MuxTerminal | undefined> => {
			const currentSnapshot = client.store.getSnapshot();
			const targetSession = target
				? currentSnapshot.sessionsById.get(target.sessionId)
				: targetSessionId
					? currentSnapshot.sessionsById.get(targetSessionId)
					: activeSession;
			const targetTabIds = targetSession
				? (currentSnapshot.visibleTabIdsBySession.get(targetSession.id) ?? EMPTY_TAB_IDS)
				: EMPTY_TAB_IDS;
			const preferredTabId = target?.tabId ?? targetSession?.activeTabId ?? targetTabIds[0];
			const targetTab = preferredTabId ? currentSnapshot.tabsById.get(preferredTabId) : undefined;
			if (
				!targetSession ||
				!targetTab ||
				!isLiveSessionTab(targetSession, targetTab) ||
				closingTabIdsRef.current.has(targetTab.id)
			) {
				return undefined;
			}
			let destinationTabId = targetTab.id;
			const navigationIntent = ++navigationIntentRef.current;
			setActionError(undefined);
			try {
				// A new Window starts an async terminal creation. If that Window was
				// closed while terminal creation was in flight, do not send its stale
				// tab id back to the host.
				const liveSnapshot = client.store.getSnapshot();
				const liveSession = liveSnapshot.sessionsById.get(targetSession.id);
				const liveTab = liveSnapshot.tabsById.get(targetTab.id);
				if (
					!liveSession ||
					!liveTab ||
					!isLiveSessionTab(liveSession, liveTab) ||
					closingTabIdsRef.current.has(targetTab.id)
				) {
					return undefined;
				}

				const input: TerminalInput = { _tag: "TerminalInput", kind: "terminal" };
				const targetTerminalIds =
					liveSnapshot.terminalIdsByTab.get(liveTab.id) ?? EMPTY_TERMINAL_IDS;
				const currentWorkspace =
					terminalWorkspaces.get(liveTab.id) ??
					restoreTerminalWorkspace(liveTab.layoutJson, targetTerminalIds);
				let hasEmptyPane = false;
				currentWorkspace.tree.visitLeaves((leaf) => {
					if (leaf.view.kind === "empty") hasEmptyPane = true;
				});
				let destinationTab = liveTab;
				let rollbackTab: SessionTab | undefined;
				if (terminalPaneCount(currentWorkspace) >= MAX_TERMINAL_TILES && !hasEmptyPane) {
					const liveTabIds =
						liveSnapshot.visibleTabIdsBySession.get(liveSession.id) ?? EMPTY_TAB_IDS;
					const createdTab = await hostPorts.mux.createTab?.({
						_tag: "CreateSessionTab",
						sessionId: liveSession.id,
						title: `Window ${liveTabIds.length + 1}`,
					});
					if (!createdTab) throw new Error("Could not create another Window.");
					destinationTab = createdTab;
					destinationTabId = createdTab.id;
					rollbackTab = createdTab;
				}

				const requestSnapshot = client.store.getSnapshot();
				const requestSession = requestSnapshot.sessionsById.get(liveSession.id);
				const requestTargetTab = requestSnapshot.tabsById.get(targetTab.id);
				if (
					!requestSession ||
					!requestTargetTab ||
					!isLiveSessionTab(requestSession, requestTargetTab) ||
					closingTabIdsRef.current.has(targetTab.id)
				) {
					if (rollbackTab) {
						const rollback = hostPorts.mux.archiveTab?.({
							_tag: "ArchiveSessionTab",
							tabId: rollbackTab.id,
							mode: "stop-terminals",
						});
						if (rollback) await rollback.catch(() => undefined);
					}
					return undefined;
				}

				const command: CreateTerminal = {
					_tag: "CreateTerminal",
					sessionId: liveSession.id,
					tabId: destinationTab.id,
					kind: nextKind,
					input,
				};
				try {
					const created = await hostPorts.mux.createTerminal?.(command);
					if (created) client.store.replaceMuxTerminal(created);
					await client.reconcileSession(liveSession.id);
					if (
						created &&
						navigationIntentRef.current === navigationIntent
					) {
						const openTarget = target && destinationTab.id === target.tabId ? target : undefined;
						selectTerminal(created, openTarget);
					}
					return created;
				} catch (error) {
					if (rollbackTab) {
						const rollback = hostPorts.mux.archiveTab?.({
							_tag: "ArchiveSessionTab",
							tabId: rollbackTab.id,
							mode: "stop-terminals",
						});
						if (rollback) await rollback.catch(() => undefined);
					}
					throw error;
				}
			} catch (error) {
				const failedSnapshot = client.store.getSnapshot();
				const failedSession = failedSnapshot.sessionsById.get(targetSession.id);
				const failedTab = failedSnapshot.tabsById.get(destinationTabId);
				// Closing a Window can race the automatic terminal creation above.
				// The failed request is expected in that case, not an app error.
				if (
					closingTabIdsRef.current.has(targetTab.id) ||
					closingTabIdsRef.current.has(destinationTabId) ||
					!isLiveSessionTab(failedSession, failedTab)
				) {
					return undefined;
				}
				setActionError(errorMessage(error));
				return undefined;
			}
		},
		[activeSession, client, hostPorts.mux, selectTerminal, terminalWorkspaces],
	);

	const selectTab = useCallback(
		(tab: SessionTab) => {
			navigationIntentRef.current += 1;
			const currentSnapshot = client.store.getSnapshot();
			const session = currentSnapshot.sessionsById.get(tab.sessionId);
			const currentTab = currentSnapshot.tabsById.get(tab.id);
			if (
				!session ||
				!currentTab ||
				!isLiveSessionTab(session, currentTab) ||
				closingTabIdsRef.current.has(tab.id)
			) {
				return;
			}
			markPerformance("yaade:tab-switch");
			serverConnections.manager.selectTab(tab.id);
			client.store.selectTab(tab.id);
			const nextTerminal = client.store.getSnapshot().activeMuxTerminalId;
			writeMuxSessionLocation(muxSessionUrl(session.id, tab.id, nextTerminal), "push");
		},
		[client, serverConnections.manager],
	);

	const createTab = useCallback(async () => {
		if (!activeSession) return;
		const navigationIntent = ++navigationIntentRef.current;
		try {
			const tab = await hostPorts.mux.createTab?.({
				_tag: "CreateSessionTab",
				sessionId: activeSession.id,
				title: nextWindowTitle(visibleTabs),
			});
			if (!tab) return;
			await client.reconcileSession(activeSession.id);
			if (navigationIntentRef.current === navigationIntent) selectTab(tab);
		} catch (error) {
			setActionError(errorMessage(error));
		}
	}, [activeSession, client, selectTab, visibleTabs]);

	const renameTab = useCallback(
		async (id: SessionTabId, title: string) => {
			try {
				const tab = await hostPorts.mux.renameTab?.({ _tag: "RenameSessionTab", tabId: id, title });
				if (tab) client.store.replaceTab(tab);
			} catch (error) {
				setActionError(errorMessage(error));
			}
		},
		[client],
	);

	const reorderTabs = useCallback(
		async (ids: readonly SessionTabId[]) => {
			if (!activeSession) return;
			try {
				await hostPorts.mux.reorderTabs?.({
					_tag: "ReorderSessionTabs",
					sessionId: activeSession.id,
					tabIds: ids,
				});
				await client.reconcileSession(activeSession.id);
			} catch (error) {
				setActionError(errorMessage(error));
			}
		},
		[activeSession, client],
	);

	const closeTab = useCallback(
		async (tab: SessionTab) => {
			closingTabIdsRef.current.add(tab.id);
			setActionError(undefined);
			try {
				await client.closeTab({
					_tag: "ArchiveSessionTab",
					tabId: tab.id,
					mode: "stop-terminals",
				});
			} catch (error) {
				setActionError(errorMessage(error));
			} finally {
				closingTabIdsRef.current.delete(tab.id);
			}
		},
		[client],
	);

	const createSession = useCallback(async (title = "New session", serverId?: string) => {
		const navigationIntent = ++navigationIntentRef.current;
		try {
			if (serverId) serverConnections.manager.selectServer(serverId);
			const created = await hostPorts.mux.createSession?.(title);
			if (!created) return;
			await client.reconcile();
			if (navigationIntentRef.current === navigationIntent) {
				selectSession(created.id);
			}
		} catch (error) {
			setActionError(errorMessage(error));
		}
	}, [client, selectSession, serverConnections.manager]);

	const runTerminalAction = useCallback(
		async (action: "cancel" | "restart" | "archive", terminal: MuxTerminal) => {
			setActionError(undefined);
			try {
				if (action === "archive") {
					await client.closeTerminal({
						_tag: "CloseTerminal",
						muxTerminalId: terminal.id,
					});
					return;
				}
				const api = hostPorts.mux;
				const result = action === "cancel"
					? await api?.stopTerminal?.(terminal.id, terminal.revision)
					: await api?.restartTerminal?.(terminal.id, terminal.revision);
				if (result) client.store.replaceMuxTerminal(result);
				await client.reconcileSession(terminal.sessionId);
			} catch (error) {
				setActionError(errorMessage(error));
				if (action !== "archive") {
					await client.reconcileSession(terminal.sessionId).catch(() => undefined);
				}
			}
		},
		[client],
	);

	const closeSession = useCallback(
		async (sessionId: SessionId, mode: "keep-running" | "stop-terminals") => {
			try {
				const archived = await hostPorts.mux.archiveSession?.({
					_tag: "ArchiveSession",
					sessionId,
					mode,
				});
				if (archived) {
					client.store.apply({
						_tag: "SessionArchived",
						eventId: `local:${archived.id}`,
						revision: archived.revision ?? 1,
						occurredAt: archived.updatedAt,
						session: archived,
					});
				}
				await client.reconcile();
				setCloseChoice(undefined);
			} catch (error) {
				setActionError(errorMessage(error));
			}
		},
		[client],
	);

	const requestCloseSession = useCallback(
		(sessionId: SessionId) => {
			const sessionTerminals = client.store.getSnapshot().terminalIdsBySession.get(sessionId) ?? [];
			const live = sessionTerminals.some((id) => {
				const terminal = client.store.getSnapshot().terminalsById.get(id);
				return terminal ? isLive(terminal) : false;
			});
			if (live) setCloseChoice({ sessionId });
			else void closeSession(sessionId, "keep-running");
		},
		[client, closeSession],
	);

	const renameSession = useCallback(
		async (id: SessionId, title: string) => {
			const renamed = await hostPorts.mux.renameSession?.(id, title);
			if (renamed) await client.reconcile();
		},
		[client],
	);

	const reorderSessions = useCallback(
		async (ids: readonly SessionId[]) => {
			await hostPorts.mux.reorderSessions?.({
				_tag: "ReorderSessions",
				sessionIds: ids,
			});
			await client.reconcile();
		},
		[client],
	);

	const renameMuxTerminal = useCallback(
		async (terminal: MuxTerminal, title: string) => {
			const renamed = await hostPorts.mux.renameTerminal?.(terminal.id, title);
			if (renamed) client.store.replaceMuxTerminal(renamed);
		},
		[client],
	);

	const reorderMuxTerminals = useCallback(
		async (ids: readonly MuxTerminalId[]) => {
			if (!activeSession || !activeTab) return;
			await hostPorts.mux.reorderTerminals?.({
				_tag: "ReorderTerminals",
				sessionId: activeSession.id,
				tabId: activeTab.id,
				muxTerminalIds: ids,
			});
			await client.reconcileSession(activeSession.id);
		},
		[activeSession, activeTab, client],
	);

	useEffect(() => {
		const bridge = window.__yaadeTest;
		if (!bridge) return;
		const previous = {
			getState: bridge.getState,
			createSession: bridge.createSession,
			selectSession: bridge.selectSession,
			createTab: bridge.createTab,
			selectTab: bridge.selectTab,
			closeTab: bridge.closeTab,
			createMuxTerminal: bridge.createMuxTerminal,
			selectMuxTerminal: bridge.selectMuxTerminal,
			closeMuxTerminal: bridge.closeMuxTerminal,
			closeSession: bridge.closeSession,
			getPerfMeasures: bridge.getPerfMeasures,
		};
		const sessionFor = (id: string) =>
			[...snapshot.sessionsById.values()].find((session) => session.id === id);
		const terminalFor = (id: string) =>
			[...snapshot.terminalsById.values()].find((terminal) => terminal.id === id);
		const tabFor = (id: string) => [...snapshot.tabsById.values()].find((tab) => tab.id === id);
		bridge.getState = () => ({
			...previous.getState(),
			route: "session",
			activeSessionId: snapshot.activeSessionId ?? null,
			activeTabId: snapshot.activeTabId ?? null,
			activeMuxTerminalId: snapshot.activeMuxTerminalId ?? null,
			sessions: visibleSessions,
			tabs: activeSession
				? (snapshot.visibleTabIdsBySession.get(activeSession.id) ?? [])
					.map((id) => snapshot.tabsById.get(id))
					.filter((tab): tab is SessionTab => Boolean(tab))
				: [],
			muxTerminals: [...snapshot.terminalsById.values()].filter((terminal) => !terminal.archivedAt),
			connection: snapshot.connection,
		});
		bridge.createSession = async () => {
			await createSession();
		};
		bridge.selectSession = async (id) => {
			const session = sessionFor(id);
			if (session) selectSession(session.id);
		};
		bridge.createTab = async () => {
			await createTab();
		};
		bridge.selectTab = async (id) => {
			const tab = tabFor(id);
			if (tab) selectTab(tab);
		};
		bridge.closeTab = async (id) => {
			const tab = tabFor(id);
			if (tab) await closeTab(tab);
		};
		bridge.createMuxTerminal = async (nextKind) => {
			await createTerminal(nextKind);
		};
		bridge.selectMuxTerminal = async (id) => {
			const terminal = terminalFor(id);
			if (terminal) selectTerminal(terminal);
		};
		bridge.closeMuxTerminal = async (id) => {
			const terminal = terminalFor(id);
			if (terminal) await runTerminalAction("archive", terminal);
		};
		bridge.closeSession = async (id, mode = "keep-running") => {
			const session = sessionFor(id);
			if (session) await closeSession(session.id, mode);
		};
		bridge.getPerfMeasures = (names?: string[]) => {
			try {
				const measures = performance
					.getEntriesByType("measure")
					.filter((entry) => entry.name.startsWith("yaade:"))
					.filter((entry) => !names || names.includes(entry.name))
					.map((entry) => ({ name: entry.name, durationMs: entry.duration }));
				return measures;
			} catch {
				return previous.getPerfMeasures?.(names) ?? [];
			}
		};
		return () => {
			bridge.getState = previous.getState;
			bridge.createSession = previous.createSession;
			bridge.selectSession = previous.selectSession;
			bridge.createTab = previous.createTab;
			bridge.selectTab = previous.selectTab;
			bridge.closeTab = previous.closeTab;
			bridge.createMuxTerminal = previous.createMuxTerminal;
			bridge.selectMuxTerminal = previous.selectMuxTerminal;
			bridge.closeMuxTerminal = previous.closeMuxTerminal;
			bridge.closeSession = previous.closeSession;
			bridge.getPerfMeasures = previous.getPerfMeasures;
		};
	}, [
		activeSession,
		closeSession,
		closeTab,
		createSession,
		createTab,
		createTerminal,
		runTerminalAction,
		selectSession,
		selectTab,
		selectTerminal,
		snapshot,
		visibleSessions,
	]);

	const clearPrefix = useCallback(() => {
		clearMuxSessionKeymapState(keymapStateRef.current);
		prefixStartedInTerminalRef.current = false;
		if (prefixTimerRef.current !== undefined) {
			window.clearTimeout(prefixTimerRef.current);
			prefixTimerRef.current = undefined;
		}
		setPrefixPending(false);
	}, []);

	const showPrefix = useCallback(() => {
		if (prefixTimerRef.current !== undefined) {
			window.clearTimeout(prefixTimerRef.current);
		}
		setPrefixPending(true);
		prefixTimerRef.current = window.setTimeout(() => {
			clearMuxSessionKeymapState(keymapStateRef.current);
			prefixStartedInTerminalRef.current = false;
			prefixTimerRef.current = undefined;
			setPrefixPending(false);
		}, CHORD_TIMEOUT_MS);
	}, []);

	const commandHandlers = useMemo<CommandHandlers>(
		() => ({
			"commandPalette.show": () => setCommandPaletteOpen(true),
			"session.new": async () => createSession(),
			"tab.new": async () => createTab(),
			"tab.close": async () => {
				if (activeTab) await closeTab(activeTab);
			},
			"tab.next": () => {
				if (!activeTab || tabIds.length === 0) return;
				const index = tabIds.indexOf(activeTab.id);
				const next = snapshot.tabsById.get(tabIds[(index + 1) % tabIds.length]!);
				if (next) selectTab(next);
			},
			"tab.previous": () => {
				if (!activeTab || tabIds.length === 0) return;
				const index = tabIds.indexOf(activeTab.id);
				const next = snapshot.tabsById.get(
					tabIds[(index - 1 + tabIds.length) % tabIds.length]!,
				);
				if (next) selectTab(next);
			},
			"terminal.newTerminal": async () => {
				await createTerminal("terminal");
			},
			"session.switch": () => setSwitcherOpen(true),
			"terminal.switch": () => setTerminalSwitcherOpen(true),
			"terminal.switchPrevious": switchToPreviousTerminal,
			"terminal.next": () => {
				if (!selected || terminalIds.length === 0) return;
				const index = terminalIds.indexOf(selected.id);
				const next = snapshot.terminalsById.get(
					terminalIds[(index + 1) % terminalIds.length]!,
				);
				if (next) selectTerminal(next);
			},
			"terminal.previous": () => {
				if (!selected || terminalIds.length === 0) return;
				const index = terminalIds.indexOf(selected.id);
				const next = snapshot.terminalsById.get(
					terminalIds[(index - 1 + terminalIds.length) % terminalIds.length]!,
				);
				if (next) selectTerminal(next);
			},
			"terminal.jump": (invocation) => {
				if (invocation.jumpIndex == null) return;
				const id = terminalIds[invocation.jumpIndex];
				const next = id ? snapshot.terminalsById.get(id) : undefined;
				if (next) selectTerminal(next);
			},
			"terminal.jumpLive": () => {
				const target = focusedMuxTerminalRef.current ?? selected;
				if (target) jumpRegisteredTerminalToLive(target.id);
			},
			"terminal.toggleInspectionPause": () => {
				const target = focusedMuxTerminalRef.current ?? selected;
				if (target) toggleRegisteredTerminalInspectionPause(target.id);
			},
			"terminal.close": async () => {
				const target = focusedMuxTerminalRef.current ?? selected;
				if (target) await runTerminalAction("archive", target);
			},
			"session.close": () => {
				if (activeSession) requestCloseSession(activeSession.id);
			},
			"pane.zoom": () => {
				if (!activeTab) return;
				updateTerminalWorkspace(activeTab.id, (workspace) =>
					toggleTerminalPanelZoom(workspace, workspace.focusedPanelId),
				);
			},
			"pane.splitRight": () => splitFocusedTerminalPanel("right"),
			"pane.splitDown": () => splitFocusedTerminalPanel("bottom"),
			"sidebar.toggle": toggleSidebars,
			"settings.show": () => setSettingsOpen(true),
			"keymap.reset": () => {
				resetKeymap();
			},
		}),
		[
			activeSession,
			activeTab,
			createSession,
			createTab,
			closeTab,
			createTerminal,
			resetKeymap,
			requestCloseSession,
			runTerminalAction,
			selectTab,
			selectTerminal,
			selected,
			snapshot.tabsById,
			snapshot.terminalsById,
			splitFocusedTerminalPanel,
			switchToPreviousTerminal,
			toggleSidebars,
			tabIds,
			updateTerminalWorkspace,
			terminalIds,
		],
	);
	const commandRuntime = useMemo<CommandRuntime>(
		() =>
			createCommandRuntime({
				context: () => {
					const target = focusedMuxTerminalRef.current ?? selected;
					const viewport = readTerminalViewportActivity(target?.id);
					return {
						hasActiveSession: Boolean(activeSession),
						hasActiveTab: Boolean(activeTab),
						hasActiveTerminal: Boolean(target),
						availableTerminalCount: [...snapshot.terminalsById.values()].filter(
							(terminal) => !terminal.archivedAt,
						).length,
						activeTabTerminalCount: terminalIds.length,
						tabCount: tabIds.length,
						sidebarLayout,
						viewportMode: viewport?.mode ?? "unavailable",
						viewportCanPause: viewport?.canPause ?? false,
					};
				},
				handlers: commandHandlers,
				onError: setActionError,
			}),
		[
			activeSession,
			activeTab,
			commandHandlers,
			selected,
			sidebarLayout,
			snapshot.terminalsById,
			tabIds.length,
			terminalIds.length,
		],
	);
	const keyboardSettingsModel: KeyboardSettingsModel = {
		leader: keymapSettings.effectiveKeymap.leader,
		rows: COMMAND_CATALOG.map((descriptor) => ({
			id: descriptor.id,
			title: descriptor.title,
			category: commandCategoryLabel(descriptor.category),
			context: commandContextLabel(descriptor.availability),
			defaultBinding: muxSessionPrimaryShortcutFor(
				descriptor.id,
				DEFAULT_KEYMAP_CATALOG,
			),
			effectiveBinding: muxSessionPrimaryShortcutFor(
				descriptor.id,
				keymapSettings.effectiveKeymap,
			),
			overridden: keymapSettings.profile.bindings.some(
				(binding) => binding.command === descriptor.id,
			),
			configurable:
				descriptor.id !== "terminal.jump" && descriptor.id !== "settings.show",
		})),
		conflicts: keymapSettings.conflicts.map((item) => ({ message: item.message })),
		canConfirmRisky:
			keymapSettings.conflicts.length > 0 &&
			keymapSettings.conflicts.every(
				(item) => item.code === "risky-confirmation-required",
			),
		diagnostic: keymapDiagnosticLabel(keymapSettings.diagnostic),
		exportJson: keymapSettings.exportProfile(),
		onCaptureLeader: (capture: KeyboardCapture) => {
			const binding = bindingFromKeyboardEvent(capture, keymapSettings.platform);
			return binding ? keymapSettings.setLeader(binding) : false;
		},
		onCaptureBinding: (id: string, capture: KeyboardCapture) => {
			if (!isMuxSessionCommand(id)) return false;
			const binding = bindingFromKeyboardEvent(capture, keymapSettings.platform);
			if (!binding) return false;
			const direct = capture.metaKey || capture.ctrlKey || capture.altKey;
			return keymapSettings.setBinding(id, direct ? binding : `Leader ${binding}`);
		},
		onClearBinding: (id: string) =>
			isMuxSessionCommand(id) ? keymapSettings.setBinding(id, null) : false,
		onRestoreBinding: (id: string) =>
			isMuxSessionCommand(id) ? keymapSettings.restoreBinding(id) : false,
		onConfirmRisky: keymapSettings.confirmPending,
		onImport: keymapSettings.importProfile,
		onReset: keymapSettings.resetKeymap,
	};
	const commandRuntimeRef = useRef(commandRuntime);
	commandRuntimeRef.current = commandRuntime;
	useEffect(() => {
		if (!desktopClient) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void import("@tauri-apps/api/event")
			.then(({ listen }) =>
				listen("yaade://menu-command", (event) => {
					const command = decodeMuxSessionCommand(event.payload);
					if (Option.isSome(command)) {
						void commandRuntimeRef.current.execute(command.value, { source: "native-menu" });
					}
				}),
			)
			.then((stop) => {
				if (disposed) stop();
				else unlisten = stop;
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [desktopClient]);
	const selectedTerminalRef = useRef(selected);
	selectedTerminalRef.current = selected;
	const keybindingContextRef = useRef<
		Pick<MuxSessionKeydownContext, "overlayOpen" | "zoomed" | "sidebarLayout" | "contextKind">
	>({ overlayOpen: false, zoomed: false });
	keybindingContextRef.current = {
		overlayOpen: Boolean(
			switcherOpen ||
			muxTerminalSwitcherOpen ||
			commandPaletteOpen ||
			settingsOpen ||
			closeChoice ||
			paneChromeOverlayOpen,
		),
		zoomed: Boolean(
			activeSession && activeTab && terminalWorkspaces.get(activeTab.id)?.zoomedPanelId,
		),
		sidebarLayout,
		contextKind: selected?.kind,
	};

	useEffect(() => {
		const keymapState = keymapStateRef.current;
		const suppressedKeyCodes = new Set<string>();
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target instanceof HTMLElement ? event.target : null;
			const inTerminal = Boolean(
				target?.closest("[data-ghostty-terminal-input], [data-ghostty-terminal-canvas]"),
			);
			const inEditable =
				!inTerminal && Boolean(target?.closest("input, textarea, [contenteditable=true]"));
			const result = resolveMuxSessionKeydown(event, keymapStateRef.current, {
				...keybindingContextRef.current,
				inEditable,
				inTerminal: inTerminal || prefixStartedInTerminalRef.current,
				inPrefixButton: Boolean(target?.closest("[data-yaade-which-key-item]")),
			});
			if (!result) return;

			if (event.code) suppressedKeyCodes.add(event.code);
			event.preventDefault();
			event.stopPropagation();
			if (result.type === "prefix-started") {
				prefixStartedInTerminalRef.current = inTerminal;
				showPrefix();
				return;
			}
			if (result.type === "prefix-literal") {
				clearPrefix();
				const target = focusedMuxTerminalRef.current ?? selectedTerminalRef.current;
				const ptyId = target?.output.kind === "process" ? target.output.ptyId : undefined;
				if (ptyId) {
					void hostPorts.terminal.write(ptyId, result.byte).catch((error) => {
						setActionError(errorMessage(error));
					});
				}
				return;
			}
			if (result.type === "command") {
				clearPrefix();
				void commandRuntimeRef.current.execute(result.command, {
					source: "keyboard",
					jumpIndex: result.jumpIndex,
				});
				return;
			}
			if (result.type === "consume" && keymapStateRef.current.prefix !== null) return;
			clearPrefix();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (!suppressedKeyCodes.delete(event.code)) return;
			event.preventDefault();
			event.stopPropagation();
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			if (prefixTimerRef.current !== undefined) {
				window.clearTimeout(prefixTimerRef.current);
				prefixTimerRef.current = undefined;
			}
			clearMuxSessionKeymapState(keymapState);
		};
	}, [clearPrefix, hostPorts, showPrefix]);

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!prefixPending) return;
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest("[data-yaade-which-key]")) return;
			clearPrefix();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, [clearPrefix, prefixPending]);

	const muxOverlayOpen = Boolean(
		switcherOpen ||
		muxTerminalSwitcherOpen ||
		commandPaletteOpen ||
		settingsOpen ||
		closeChoice ||
		paneChromeOverlayOpen,
	);
	useEffect(() => {
		if (muxOverlayOpen) {
			overlayWasOpenRef.current = true;
			clearPrefix();
			return;
		}
		if (!overlayWasOpenRef.current) return;
		overlayWasOpenRef.current = false;
		const target = focusedMuxTerminalRef.current ?? selectedTerminalRef.current;
		const tabId = target?.kind === "terminal" ? target.id : undefined;
		const raf = requestAnimationFrame(() => {
			focusRegisteredTerminal(tabId);
		});
		return () => cancelAnimationFrame(raf);
	}, [clearPrefix, muxOverlayOpen]);

	const activeTerminalWorkspace = useMemo(() => {
		if (!activeTab) return createTerminalWorkspace();
		return (
			terminalWorkspaces.get(activeTab.id) ??
			restoreTerminalWorkspace(activeTab.layoutJson, terminalIds)
		);
	}, [activeTab, terminalWorkspaces, terminalIds]);
	const activeWorkspaceTerminalIds = useMemo(
		() => terminalIdsInWorkspace(activeTerminalWorkspace),
		[activeTerminalWorkspace],
	);
	useEffect(() => {
		setResidentTerminalIds((previous) => {
			const next = new Set<MuxTerminalId>();
			for (const id of previous) {
				const terminal = snapshot.terminalsById.get(id);
				if (terminal && !terminal.archivedAt) {
					next.add(id);
				}
			}
			for (const id of activeWorkspaceTerminalIds) {
				const terminal = snapshot.terminalsById.get(id);
				if (terminal && !terminal.archivedAt && terminalHasResidentSurface(terminal)) {
					next.add(id);
				}
			}
			if (
				next.size === previous.size &&
				[...next].every((id) => previous.has(id))
			) {
				return previous;
			}
			return next;
		});
	}, [activeWorkspaceTerminalIds, snapshot.terminalsById]);
	const residentTerminals = useMemo(
		() =>
			[...residentTerminalIds]
				.map((id) => snapshot.terminalsById.get(id))
				.filter((terminal): terminal is MuxTerminal => Boolean(terminal)),
		[residentTerminalIds, snapshot.terminalsById],
	);
	const focusedView = activeTerminalWorkspace.tree.getView(activeTerminalWorkspace.focusedPanelId);
	focusedMuxTerminalRef.current =
		focusedView?.kind === "terminal"
			? snapshot.terminalsById.get(focusedView.muxTerminalId)
			: undefined;

	useEffect(() => {
		if (!activeSession || !activeTab || snapshot.connection !== "connected") {
			return;
		}
		const route = parseMuxSessionRoute(location.href);
		if (
			shouldHoldRequestedRoute(route, snapshot, snapshot.connection) ||
			(route.sessionId && !sameLocalResource(activeSession.id, route.sessionId)) ||
			(route.muxTerminalId &&
				!sameLocalResource(snapshot.activeMuxTerminalId, route.muxTerminalId) &&
				[...snapshot.terminalsById.keys()].some((id) => sameLocalResource(id, route.muxTerminalId)))
		) {
			return;
		}
		const emptyPanel = firstEmptyTerminalPanel(activeTerminalWorkspace);
		if (!emptyPanel) return;

		// A terminal may exist remotely while its restored view is still being placed.
		// Let the restore effect finish before treating the pane as unconfigured.
		if (terminalIds.length > 0 && terminalIdsInWorkspace(activeTerminalWorkspace).length === 0) {
			return;
		}

		const requestKey = `${activeTab.id}:${emptyPanel.id}`;
		if (pendingTerminalPanelRequestsRef.current.has(requestKey)) return;
		pendingTerminalPanelRequestsRef.current.add(requestKey);
		void createTerminal("terminal", activeSession.id, {
			sessionId: activeSession.id,
			tabId: activeTab.id,
			panelId: emptyPanel,
		}).finally(() => {
			pendingTerminalPanelRequestsRef.current.delete(requestKey);
		});
	}, [
		activeSession,
		activeTab,
		activeTerminalWorkspace,
		createTerminal,
		snapshot.connection,
		snapshot.activeMuxTerminalId,
		snapshot.terminalsById,
		terminalIds,
	]);

	const activeTabForLayoutRef = useRef(activeTab);
	activeTabForLayoutRef.current = activeTab;

	useEffect(() => {
		const currentTab = activeTabForLayoutRef.current;
		if (!currentTab) return;
		const workspace = terminalWorkspaces.get(currentTab.id);
		if (!workspace) return;
		const layoutJson = serializeTerminalWorkspace(workspace);
		if (layoutJson === currentTab.layoutJson) return;
		const tabId = currentTab.id;
		const sessionId = currentTab.sessionId;
		const handle = window.setTimeout(() => {
			const save = hostPorts.mux.saveTabLayout;
			if (!save) return;
			const previous = layoutSaveTails.current.get(tabId) ?? Promise.resolve();
			const operation = previous
				.catch(() => undefined)
				.then(async () => {
					for (let attempt = 0; attempt < 2; attempt += 1) {
						const currentTab = client.store.getSnapshot().tabsById.get(tabId);
						if (!currentTab || currentTab.archivedAt) return;
						try {
							const tab = await save({
								_tag: "SaveSessionTabLayout",
								tabId,
								layoutJson,
								revision: currentTab.revision ?? 1,
							});
							client.store.replaceTab(tab);
							return;
						} catch (error) {
							if (!(error instanceof SessionTabConflict)) throw error;
							// The captured layout is stale after a concurrent writer won.
							// Reconcile first; the effect will serialize the current local
							// workspace against the new revision instead of replaying stale
							// bytes immediately.
							await client.reconcileSession(sessionId);
							return;
						}
					}
				})
				.catch((error) => setActionError(errorMessage(error)))
				.then(() => undefined);
			layoutSaveTails.current.set(tabId, operation);
			void operation.then(() => {
				if (layoutSaveTails.current.get(tabId) === operation) {
					layoutSaveTails.current.delete(tabId);
				}
			});
		}, 350);
		return () => window.clearTimeout(handle);
	}, [activeTab?.id, client, terminalWorkspaces]);

	const openMuxTerminalIds = useMemo(
		() => new Set(terminalIdsInWorkspace(activeTerminalWorkspace)),
		[activeTerminalWorkspace],
	);
	const activeSessionTerminalIds = useMemo(() => new Set(terminalIds), [terminalIds]);

	const muxTerminalIdForDrag = useCallback(
		(tabId: string): MuxTerminalId | undefined => {
			for (const terminalId of snapshot.terminalsById.keys()) {
				if (terminalId === tabId) return terminalId;
			}
			return undefined;
		},
		[snapshot.terminalsById],
	);

	const activateDockedTerminal = useCallback(
		(terminal: MuxTerminal) => {
			const alreadyActive = client.store.getSnapshot().activeMuxTerminalId === terminal.id;
			serverConnections.manager.selectMuxTerminal(terminal.id);
			if (!alreadyActive) {
				client.store.selectMuxTerminal(terminal.id);
				const request = hostPorts.mux.selectTerminal?.(terminal.sessionId, terminal.id);
				if (request) {
					void request.catch(async (error) => {
						setActionError(errorMessage(error));
						await client.reconcileSession(terminal.sessionId).catch(() => undefined);
					});
				}
			}
			const tabId = terminal.tabId ?? client.store.getSnapshot().activeTabId;
			writeMuxSessionLocation(muxSessionUrl(terminal.sessionId, tabId, terminal.id), "replace");
			pendingFocusHistoryRef.current.delete(terminal.id);
			recordTerminalFocus(terminal);
		},
		[client, hostPorts.mux, recordTerminalFocus, serverConnections.manager],
	);

	const dockWindowTerminal = useCallback(
		async (muxTerminalId: MuxTerminalId, target: PanelId, action: DropAction) => {
			if (!activeTab) return;
			const terminal = client.store.getSnapshot().terminalsById.get(muxTerminalId);
			if (!terminal) return;

			const preview = dockTerminalView(activeTerminalWorkspace, muxTerminalId, target, action);
			if (preview === activeTerminalWorkspace) return;
			if (!terminal.tabId || terminal.tabId === activeTab.id) {
				updateTerminalWorkspace(activeTab.id, (workspace) =>
					dockTerminalView(workspace, muxTerminalId, target, action),
				);
				activateDockedTerminal(terminal);
				return;
			}

			const sourceTabId = terminal.tabId;
			const sourceTerminalIds =
				client.store.getSnapshot().terminalIdsByTab.get(sourceTabId) ?? EMPTY_TERMINAL_IDS;
			const moveTerminal = hostPorts.mux.moveTerminal;
			if (!moveTerminal) return;

			setActionError(undefined);
			try {
				const moved = await moveTerminal({
					_tag: "MoveTerminalToTab",
					muxTerminalId,
					targetTabId: activeTab.id,
				});
				client.store.replaceMuxTerminal(moved);

				const remainingSourceIds = new Set(
					sourceTerminalIds.filter((terminalId) => terminalId !== muxTerminalId),
				);
				updateTerminalWorkspace(sourceTabId, (workspace) =>
					removeMissingTerminalViews(workspace, remainingSourceIds),
				);
				updateTerminalWorkspace(activeTab.id, (workspace) =>
					dockTerminalView(workspace, muxTerminalId, target, action),
				);
				activateDockedTerminal(moved);

				if (remainingSourceIds.size === 0) {
					closingTabIdsRef.current.add(sourceTabId);
					try {
						await hostPorts.mux.archiveTab?.({
							_tag: "ArchiveSessionTab",
							tabId: sourceTabId,
							mode: "keep-running",
						});
						setTerminalWorkspaces((previous) => {
							if (!previous.has(sourceTabId)) return previous;
							const next = new Map(previous);
							next.delete(sourceTabId);
							return next;
						});
					} finally {
						closingTabIdsRef.current.delete(sourceTabId);
					}
				}
				await client.reconcileSession(terminal.sessionId);
			} catch (error) {
				setActionError(errorMessage(error));
				await client.reconcileSession(terminal.sessionId).catch(() => undefined);
			}
		},
		[
			activeTab,
			activeTerminalWorkspace,
			activateDockedTerminal,
			client,
			hostPorts.mux,
			updateTerminalWorkspace,
		],
	);

	const reorderWindowTabs = useCallback(
		(sourceId: string, targetId: string) => {
			if (sourceId === targetId) return;
			const ids = visibleTabs.map((tab) => tab.id);
			const sourceIndex = ids.findIndex((id) => id === sourceId);
			const targetIndex = ids.findIndex((id) => id === targetId);
			if (sourceIndex < 0 || targetIndex < 0) return;
			const [source] = ids.splice(sourceIndex, 1);
			if (!source) return;
			ids.splice(targetIndex, 0, source);
			void reorderTabs(ids);
		},
		[reorderTabs, visibleTabs],
	);

	const terminalTabDnd = useMemo((): TabDndHandlers => {
		return {
			onTabReorder: (panelId, tabId, toIndex) => {
				if (!activeTab) return;
				const muxTerminalId = muxTerminalIdForDrag(tabId);
				if (!muxTerminalId) return;
				updateTerminalWorkspace(activeTab.id, (workspace) =>
					reorderTerminalTabs(workspace, panelId, muxTerminalId, toIndex),
				);
			},
			tabIdsForPanel: (panelId) => {
				const view = activeTerminalWorkspace.tree.getView(panelId);
				return view?.kind === "terminal" ? [view.muxTerminalId] : [];
			},
			onTabDrop: (_source, sourceTabId, target, action) => {
				if (!activeTab) return;
				const muxTerminalId = muxTerminalIdForDrag(sourceTabId);
				if (!muxTerminalId) return;
				const terminal = snapshot.terminalsById.get(muxTerminalId);
				updateTerminalWorkspace(activeTab.id, (workspace) =>
					dockTerminalView(workspace, muxTerminalId, target, action),
				);
				if (terminal) activateDockedTerminal(terminal);
			},
			onSessionDrop: (sourceTabId, target, action) => {
				const muxTerminalId = muxTerminalIdForDrag(sourceTabId);
				if (!muxTerminalId) return;
				void dockWindowTerminal(muxTerminalId, target, action);
			},
			onSessionReorder: reorderWindowTabs,
		};
	}, [
		activeTab,
		activeTerminalWorkspace,
		activateDockedTerminal,
		dockWindowTerminal,
		snapshot.terminalsById,
		muxTerminalIdForDrag,
		reorderWindowTabs,
		updateTerminalWorkspace,
	]);

	const closeWorkspacePane = useCallback(
		(panelId: PanelId) => {
			if (!activeTab) return;
			const view = activeTerminalWorkspace.tree.getView(panelId);
			if (view?.kind === "terminal") {
				const terminal = snapshot.terminalsById.get(view.muxTerminalId);
				if (terminal) void runTerminalAction("archive", terminal);
				return;
			}
			updateTerminalWorkspace(activeTab.id, (workspace) => closeTerminalPanel(workspace, panelId));
		},
		[
			activeTab,
			activeTerminalWorkspace,
			runTerminalAction,
			snapshot.terminalsById,
			updateTerminalWorkspace,
		],
	);

	const handleTerminalPanelEvent = useCallback(
		(event: PanelEvent) => {
			if (!activeTab) return;
			if (event.type === "splitRatiosChanged") {
				updateTerminalWorkspace(activeTab.id, (workspace) =>
					resizeTerminalSplit(workspace, event.path, event.ratios),
				);
				return;
			}
			if (event.type === "panelClose") closeWorkspacePane(event.panelId);
		},
		[activeTab, closeWorkspacePane, updateTerminalWorkspace],
	);

	const focusWorkspacePanel = useCallback(
		(panelId: PanelId, terminal?: MuxTerminal) => {
			if (!activeTab) return;
			updateTerminalWorkspace(activeTab.id, (workspace) => focusTerminalPanel(workspace, panelId));
			if (terminal) activateDockedTerminal(terminal);
		},
		[activeTab, activateDockedTerminal, updateTerminalWorkspace],
	);

	const addTerminalToSplitPanel = useCallback(
		(panelId: PanelId, edge: "right" | "bottom", kind: TerminalKind) => {
			if (!activeSession || !activeTab) return;
			const tabId = activeTab.id;
			const currentWorkspace = terminalWorkspaces.get(tabId) ?? activeTerminalWorkspace;
			const nextWorkspace = splitTerminalPanel(currentWorkspace, panelId, edge);
			if (nextWorkspace === currentWorkspace) return;
			const target: TerminalOpenTarget = {
				sessionId: activeSession.id,
				tabId,
				panelId: nextWorkspace.focusedPanelId,
			};
			updateTerminalWorkspace(tabId, (workspace) => splitTerminalPanel(workspace, panelId, edge));
			const requestKey = `${tabId}:${target.panelId.id}`;
			pendingTerminalPanelRequestsRef.current.add(requestKey);
			void createTerminal(kind, activeSession.id, target).finally(() => {
				pendingTerminalPanelRequestsRef.current.delete(requestKey);
			});
		},
		[
			activeSession,
			activeTab,
			activeTerminalWorkspace,
			createTerminal,
			terminalWorkspaces,
			updateTerminalWorkspace,
		],
	);

	const splitTerminalPanelAt = useCallback(
		(panelId: PanelId, edge: "right" | "bottom") => {
			if (!activeTabId) return;
			updateTerminalWorkspace(activeTabId, (workspace) =>
				splitTerminalPanel(workspace, panelId, edge),
			);
		},
		[activeTabId, updateTerminalWorkspace],
	);

	const zoomTerminalPanel = useCallback(
		(panelId: PanelId) => {
			if (!activeTabId) return;
			updateTerminalWorkspace(activeTabId, (workspace) =>
				toggleTerminalPanelZoom(workspace, panelId),
			);
		},
		[activeTabId, updateTerminalWorkspace],
	);

	const routedMobileTerminalId = isMobile
		? parseMuxSessionRoute(location.href).muxTerminalId
		: undefined;
	const renderTerminalController = useCallback(
		(terminal: MuxTerminal, focused: boolean, visible = true) => (
			<SelectedMuxTerminal
				key={terminal.id}
				terminal={terminal}
				theme={activeTheme}
				visible={visible && (!isMobile || terminal.id === routedMobileTerminalId)}
				focused={
					focused && !muxOverlayOpen && (!isMobile || terminal.id === routedMobileTerminalId)
				}
				onTitleChange={(title) => updateRuntimeTitle(terminal, title, "terminal")}
				onJumpToLive={() => {
					void commandRuntime.execute("terminal.jumpLive", { source: "pointer" });
				}}
				onRestart={() => void runTerminalAction("restart", terminal)}
				onClose={() => void runTerminalAction("archive", terminal)}
			/>
		),
		[
			activeTheme,
			commandRuntime,
			isMobile,
			muxOverlayOpen,
			routedMobileTerminalId,
			runTerminalAction,
			updateRuntimeTitle,
		],
	);
	const handleTerminalPlacementInteraction = useCallback(
		(terminalId: string) => {
			const muxTerminalId = [...muxTerminalsRef.current.keys()].find(
				(candidate) => candidate === terminalId,
			);
			const terminal = muxTerminalId
				? muxTerminalsRef.current.get(muxTerminalId)
				: undefined;
			if (!terminal) return;
			const matchingPanelId = activeTerminalWorkspace.tree.findPanelWithView(
				(view) => view.kind === "terminal" && view.muxTerminalId === terminal.id,
			);
			if (matchingPanelId) {
				focusWorkspacePanel(matchingPanelId, terminal);
			}
		},
		[activeTerminalWorkspace.tree, focusWorkspacePanel],
	);
	const renderTerminal = useCallback(
		(terminal: MuxTerminal, focused: boolean, visible = true) =>
			terminalHasResidentSurface(terminal) ? (
				isMobile ? (
					<div className="h-full min-h-0" data-yaade-desktop-terminal-placeholder={terminal.id} />
				) : (
					<TerminalSurfacePlacement
						key={terminal.id}
						terminalId={terminal.id}
						focused={focused && !muxOverlayOpen}
						visible={visible}
						onFocused={recordPlacedTerminalFocus}
						onInteraction={handleTerminalPlacementInteraction}
					/>
				)
			) : (
				renderTerminalController(terminal, focused, visible)
			),
		[
			handleTerminalPlacementInteraction,
			isMobile,
			muxOverlayOpen,
			recordPlacedTerminalFocus,
			renderTerminalController,
		],
	);
	const renderMobileTerminal = useCallback(
		(terminal: MuxTerminal, focused: boolean, visible = true) => (
			<TerminalSurfacePlacement
				key={terminal.id}
				terminalId={terminal.id}
				focused={focused && !muxOverlayOpen}
				visible={visible}
				onFocused={recordPlacedTerminalFocus}
				onInteraction={handleTerminalPlacementInteraction}
			/>
		),
		[handleTerminalPlacementInteraction, muxOverlayOpen, recordPlacedTerminalFocus],
	);

	const showMobileTerminalList = (terminal: MuxTerminal) => {
		const tabId = terminal.tabId ?? client.store.getSnapshot().activeTabId;
		const listUrl = muxSessionUrl(terminal.sessionId, tabId);
		if (history.state?.yaadeMobileTerminal === terminal.id) {
			history.back();
			return;
		}
		persistMuxSessionRoute(listUrl, localStorage);
		history.replaceState(null, "", listUrl);
		setRouteRevision((revision) => revision + 1);
	};

	const onPrefixHudSelect = (key: string) => {
		clearPrefix();
		if (isMuxSessionJumpKey(key)) {
			void commandRuntime.execute("terminal.jump", {
				source: "which-key",
				jumpIndex: Number(key) - 1,
			});
			return;
		}
		const binding = matchMuxSessionPrefixBinding(key);
		if (binding) {
			void commandRuntime.execute(binding.command, { source: "which-key" });
		}
	};

	const activeServerConnection =
		serverConnections.snapshot.connections.find(
			(connection) => connection.id === serverConnections.snapshot.activeServerId,
		) ?? serverConnections.snapshot.connections[0];
	const hostAccessRevoked = activeServerConnection?.status === "revoked";
	const closingSessionTitle = closeChoice
		? snapshot.sessionsById.get(closeChoice.sessionId)?.title
		: undefined;

	return (
		<MotionConfig reducedMotion="user">
			<LazyMotion features={loadMotionFeatures}>
				<TooltipProvider delayDuration={400} skipDelayDuration={200}>
					<LayoutGroup id="yaade-terminal-multiplexer">
						<AmbientCanvas asChild>
							<div
								className="flex h-full min-h-0 flex-row overflow-hidden bg-transparent text-foreground"
								data-yaade-shell="terminal-multiplexer"
								data-yaade-client={desktopClient ? "desktop" : "web"}
								data-yaade-desktop-platform={macDesktopClient ? "macos" : undefined}
								data-yaade-session-layout={appearanceSettings.sessionLayout}
								data-yaade-sidebars-state={sidebarsCollapsed ? "collapsed" : "expanded"}
							>
								<div
									className="pointer-events-none invisible absolute left-0 top-0 size-px overflow-hidden"
									aria-hidden="true"
									inert
									data-yaade-terminal-resident-host=""
								>
									{residentTerminals.map((terminal) => {
										const visible = activeWorkspaceTerminalIds.includes(terminal.id);
										const focused =
											focusedView?.kind === "terminal" &&
											focusedView.muxTerminalId === terminal.id;
										return (
											<div key={terminal.id} className="size-px" data-yaade-terminal-resident-home={terminal.id}>
												{renderTerminalController(terminal, focused, visible)}
											</div>
										);
									})}
								</div>
								<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
									<Suspense fallback={<SessionLoadingState />}>
										<TerminalDndRoot handlers={terminalTabDnd}>
											<>
												<div
													className={isMobile ? "absolute inset-0 min-h-0" : "hidden"}
													data-yaade-mobile-layout-host=""
												>
													{isMobile ? (
														<MobileTerminalView
															sessions={visibleSessions}
															terminalsById={snapshot.terminalsById}
															terminalIdsBySession={snapshot.terminalIdsBySession}
															routeMuxTerminalId={parseMuxSessionRoute(location.href).muxTerminalId}
															runtimeTitles={runtimeTitles}
															onSelect={selectTerminal}
															onShowTerminalList={showMobileTerminalList}
															onCreateTerminal={(sessionId, kind) => createTerminal(kind, sessionId)}
															onCreateSession={createSession}
															onCloseSession={requestCloseSession}
															onOpenCommands={() => {
																void commandRuntime.execute("commandPalette.show", { source: "pointer" });
															}}
															actionError={actionError}
															onCloseTerminal={(terminal) => runTerminalAction("archive", terminal)}
															onRestartTerminal={(terminal) =>
																runTerminalAction("restart", terminal)
															}
															renderTerminal={renderMobileTerminal}
														/>
													) : null}
												</div>
												<div
													className={cn(
														"relative flex min-h-0 flex-1 flex-col",
														isMobile && "pointer-events-none invisible absolute inset-0",
													)}
													aria-hidden={isMobile ? true : undefined}
													inert={isMobile ? true : undefined}
													data-yaade-desktop-layout-host=""
												>
													{!sidebarLayout ? (
														<header
															className="group/titlebar relative flex shrink-0 items-center"
															data-yaade-session-tabs=""
															data-yaade-top-tabbar=""
															data-tauri-drag-region=""
														>
															<SessionSwitcher
																open={switcherOpen}
																onOpenChange={(open) => {
																	if (open) {
																		void commandRuntime.execute("session.switch", { source: "pointer" });
																	} else setSwitcherOpen(false);
																}}
																sessions={visibleSessions}
																activeSessionId={snapshot.activeSessionId}
																onSelect={(session) => selectSession(session.id)}
																onCreate={(title, serverId) => void createSession(title, serverId)}
																onClose={requestCloseSession}
																onRename={(id, title) => void renameSession(id, title)}
																terminalCounts={terminalCounts}
																serverNamesBySessionId={serverNamesBySessionId}
																sessionStatusById={sessionStatusById}
																activeServer={activeServerConnection}
															/>
															<CommandPaletteTrigger
																side="bottom"
																className="size-[var(--yaade-tab-pill-height)] shrink-0 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
																onOpen={() => {
																	void commandRuntime.execute("commandPalette.show", { source: "pointer" });
																}}
															/>
															<ShortcutTooltip
																label="Settings"
																shortcut={muxSessionDirectShortcutFor("settings.show")}
																side="bottom"
															>
															<Button
																type="button"
																size="icon-sm"
																variant="ghost"
																	aria-label="Settings"
																onClick={() => { void commandRuntime.execute("settings.show", { source: "pointer" }); }}
																data-yaade-session-settings=""
																	className="size-[var(--yaade-tab-pill-height)] shrink-0 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
															>
																<Settings />
															</Button>
															</ShortcutTooltip>
															{!singleSidebarLayout ? (
																<SessionWindowTabStrip
																	tabs={visibleTabs}
																	activeTabId={activeTab?.id}
																	onSelect={selectTab}
																	onCreate={() => void createTab()}
																	onClose={closeTab}
																	onRename={(id, title) => void renameTab(id, title)}
																	dockTerminalIdsByTab={dockTerminalIdsByTab}
																/>
															) : null}
														</header>
													) : null}
													<div
														className={cn(
															"relative min-h-0 flex-1",
															(twoSidebarLayout || singleSidebarLayout) &&
															"grid max-md:flex max-md:flex-col yaade-terminal-multiplexer-grid",
															!sidebarLayout && "flex flex-col",
														)}
														data-tauri-drag-region=""
														style={
															twoSidebarLayout
																? {
																	gridTemplateColumns: sidebarsCollapsed
																		? "0rem minmax(0, 1fr) 0rem"
																		: `${appearanceSettings.sidebarWidth}px minmax(0, 1fr) ${appearanceSettings.sidebarWidth}px`,
																}
																: singleSidebarLayout
																	? {
																		gridTemplateColumns: sidebarsCollapsed
																			? "0rem minmax(0, 1fr)"
																			: `${appearanceSettings.sidebarWidth}px minmax(0, 1fr)`,
																	}
																	: undefined
														}
													>
														{twoSidebarLayout ? (
															<SessionTabStrip
																sessions={visibleSessions}
																activeSessionId={snapshot.activeSessionId}
																layout="two-sidebars"
																collapsed={sidebarsCollapsed}
																sidebarOrientation={sidebarOrientation}
																onSelect={selectSession}
																onClose={requestCloseSession}
																onOpenSettings={() => {
																	void commandRuntime.execute("settings.show", { source: "pointer" });
																}}
																onOpenCommands={() => {
																	void commandRuntime.execute("commandPalette.show", { source: "pointer" });
																}}
																onCreate={() => void createSession()}
																onRename={(id, title) => void renameSession(id, title)}
																onReorder={(ids) => void reorderSessions(ids)}
																serverNamesBySessionId={serverNamesBySessionId}
																terminalCounts={terminalCounts}
															/>
														) : singleSidebarLayout ? (
															<MotionAside
																initial={false}
																animate={{
																	opacity: sidebarsCollapsed ? 0 : 1,
																	x: sidebarsCollapsed ? -12 : 0,
																}}
																transition={yaadeMotion.sidebarTransition}
																className={cn(
																	"flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
																	sidebarsCollapsed && "pointer-events-none max-md:hidden",
																	"max-md:h-auto max-md:w-full max-md:border-r-0 max-md:border-b",
																)}
																aria-label="Windows"
																aria-hidden={sidebarsCollapsed || undefined}
																inert={sidebarsCollapsed || undefined}
																data-yaade-single-sidebar=""
																data-yaade-sidebar-state={
																	sidebarsCollapsed ? "collapsed" : "expanded"
																}
															>
																<SidebarProvider
																	open={!sidebarsCollapsed}
																	onOpenChange={setSidebarOpen}
																	className="h-full min-h-0 w-full"
																>
																	<Sidebar
																		collapsible="none"
																		className="w-full min-w-0 border-0 bg-transparent"
																	>
																		<SidebarHeader className="border-b border-sidebar-border/70 p-1">
																			<div className="flex items-center gap-1">
																				<SessionSwitcher
																					open={switcherOpen}
																					onOpenChange={(open) => {
																							if (open) {
																								void commandRuntime.execute("session.switch", { source: "pointer" });
																							} else setSwitcherOpen(false);
																						}}
																					sessions={visibleSessions}
																					activeSessionId={snapshot.activeSessionId}
																					onSelect={(session) => selectSession(session.id)}
																					onCreate={(title, serverId) => void createSession(title, serverId)}
																					onClose={requestCloseSession}
																					onRename={(id, title) => void renameSession(id, title)}
																					terminalCounts={terminalCounts}
																					serverNamesBySessionId={serverNamesBySessionId}
																					sessionStatusById={sessionStatusById}
																					activeServer={activeServerConnection}
																				/>
																				<CommandPaletteTrigger
																					side="right"
																					onOpen={() => {
																						void commandRuntime.execute("commandPalette.show", { source: "pointer" });
																					}}
																				/>
																				<ShortcutTooltip
																					label="Settings"
																					shortcut={muxSessionDirectShortcutFor("settings.show")}
																					side="right"
																				>
																					<Button
																						type="button"
																						size="icon-sm"
																						variant="ghost"
																						aria-label="Settings"
																						onClick={() => { void commandRuntime.execute("settings.show", { source: "pointer" }); }}
																						data-yaade-session-settings=""
																					>
																						<Settings />
																					</Button>
																				</ShortcutTooltip>
																				<Button
																					type="button"
																					variant="ghost"
																					size="icon-sm"
																					aria-label="New Window"
																					title="New Window"
																					data-yaade-new-session-tab=""
																					onClick={() => void createTab()}
																				>
																					<Plus />
																				</Button>
																				<SidebarTrigger
																					aria-label="Hide Window sidebar"
																					title="Hide Window sidebar"
																				/>
																			</div>
																		</SidebarHeader>
																		<SessionWindowTabStrip
																			placement="sidebar"
																			tabs={visibleTabs}
																			activeTabId={activeTab?.id}
																			onSelect={selectTab}
																			onCreate={() => void createTab()}
																			onClose={closeTab}
																			onRename={(id, title) => void renameTab(id, title)}
																			dockTerminalIdsByTab={dockTerminalIdsByTab}
																		/>
																	</Sidebar>
																</SidebarProvider>
															</MotionAside>
														) : null}
														{twoSidebarLayout && !sidebarsCollapsed ? (
															<SidebarResizeHandle
																value={appearanceSettings.sidebarWidth}
																min={MIN_SIDEBAR_WIDTH}
																max={MAX_SIDEBAR_WIDTH}
																side="left"
																label="Resize session sidebar"
																onChange={resizeSidebar}
															/>
														) : null}
														{singleSidebarLayout && !sidebarsCollapsed ? (
															<SidebarResizeHandle
																value={appearanceSettings.sidebarWidth}
																min={MIN_SIDEBAR_WIDTH}
																max={MAX_SIDEBAR_WIDTH}
																side="left"
																label="Resize Window sidebar"
																onChange={resizeSidebar}
															/>
														) : null}
														<main
															className={cn(
																"relative flex min-w-0 min-h-0 flex-1 flex-col",
																sidebarLayout && "col-start-2",
															)}
														>
															{twoSidebarLayout ? (
																<SessionWindowTabStrip
																	tabs={visibleTabs}
																	activeTabId={activeTab?.id}
																	onSelect={selectTab}
																	onCreate={() => void createTab()}
																	onClose={closeTab}
																	onRename={(id, title) => void renameTab(id, title)}
																	dockTerminalIdsByTab={dockTerminalIdsByTab}
																/>
															) : null}
															{snapshot.connection === "reconciling" ||
																snapshot.connection === "offline" ? (
																<Alert
																	className="mx-2 mt-2 py-2"
																	data-yaade-connection={snapshot.connection}
																>
																	<AlertTitle>
																		{hostAccessRevoked
																			? "Access revoked"
																			: snapshot.connection === "offline"
																				? "Host offline"
																				: "Reconnecting"}
																	</AlertTitle>
																	<AlertDescription>
																		{snapshot.connection === "offline"
																			? "Terminal state will refresh when the host returns."
																			: "Reconciling session state without clearing current results."}
																	</AlertDescription>
																</Alert>
															) : null}
															{actionError ? (
																<Alert
																	variant="destructive"
																	className="relative mx-2 mt-2 py-2 pr-10"
																>
																	<AlertTitle>Action failed</AlertTitle>
																	<AlertDescription>{actionError}</AlertDescription>
																	<Button
																		type="button"
																		variant="ghost"
																		size="icon-xs"
																		aria-label="Dismiss error"
																		className="absolute right-2 top-2"
																		onClick={() => setActionError(undefined)}
																	>
																		<X />
																	</Button>
																</Alert>
															) : null}
															{sidebarLayout && sidebarsCollapsed ? (
																<SidebarHoverToggle
																	side="left"
																	collapsed
																	onToggle={toggleSidebars}
																/>
															) : null}
															{twoSidebarLayout && sidebarsCollapsed ? (
																<SidebarHoverToggle
																	side="right"
																	collapsed
																	onToggle={toggleSidebars}
																/>
															) : null}
															<div className="min-h-0 flex-1">
																{snapshot.connection === "connecting" &&
																	visibleSessions.length === 0 ? (
																	<SessionLoadingState />
																) : activeSession && activeTab ? (
																	<TerminalTilingWorkspace
																		workspace={activeTerminalWorkspace}
																		terminalsById={snapshot.terminalsById}
																		runtimeTitles={runtimeTitles}
																		onPanelEvent={handleTerminalPanelEvent}
																		onFocusPanel={focusWorkspacePanel}
																		onAddSplitTerminal={addTerminalToSplitPanel}
																		onSplit={splitTerminalPanelAt}
																		onZoom={zoomTerminalPanel}
																		onCloseView={closeWorkspacePane}
																		onChromeOverlayChange={setPaneChromeOverlayOpen}
																		renderTerminal={renderTerminal}
																	/>
																) : null}
															</div>
															{prefixPending ? <PrefixHud onSelect={onPrefixHudSelect} /> : null}
														</main>
														{twoSidebarLayout ? (
															<div
																className={
																	twoSidebarLayout
																		? "relative col-start-3 min-h-0 min-w-0"
																		: "relative shrink-0"
																}
															>
																<TerminalTabStrip
																	terminalIds={terminalIds}
																	terminalsById={snapshot.terminalsById}
																	activeMuxTerminalId={snapshot.activeMuxTerminalId}
																	openMuxTerminalIds={openMuxTerminalIds}
																	runtimeTitles={runtimeTitles}
																	sessionTitlesById={sessionTitlesById}
																	sectionLabel="Terminals"
																	emptyLabel="No terminals yet"
																	layout={twoSidebarLayout ? "two-sidebars" : "tabs"}
																	collapsed={twoSidebarLayout ? sidebarsCollapsed : false}
																	sidebarOrientation={sidebarOrientation}
																	dockable
																	dockableTerminalIds={activeSessionTerminalIds}
																	onSelect={selectTerminal}
																	onAddKind={(kind) => void createTerminal(kind)}
																	onClose={(terminal) =>
																		void runTerminalAction("archive", terminal)
																	}
																	onRename={(terminal, title) =>
																		void renameMuxTerminal(terminal, title)
																	}
																	onReorder={(ids) => void reorderMuxTerminals(ids)}
																	onToggleSidebar={twoSidebarLayout ? toggleSidebars : undefined}
																/>
															</div>
														) : null}
														{twoSidebarLayout && !sidebarsCollapsed ? (
															<SidebarResizeHandle
																value={appearanceSettings.sidebarWidth}
																min={MIN_SIDEBAR_WIDTH}
																max={MAX_SIDEBAR_WIDTH}
																side="right"
																label="Resize terminal sidebar"
																onChange={resizeSidebar}
															/>
														) : null}
													</div>
												</div>
											</>
										</TerminalDndRoot>
									</Suspense>
									{commandPaletteOpen ? (
										<Suspense fallback={null}>
											<CommandPalette
												open
												onOpenChange={setCommandPaletteOpen}
												runtime={commandRuntime}
											/>
										</Suspense>
									) : null}
									{muxTerminalSwitcherOpen ? (
										<Suspense fallback={null}>
											<TerminalSwitcher
												open
												onOpenChange={setTerminalSwitcherOpen}
												entries={terminalSwitcherEntries}
												history={terminalFocusHistory}
												context={{
													activeSessionId: snapshot.activeSessionId,
													activeTabId: snapshot.activeTabId,
												}}
												activeMuxTerminalId={snapshot.activeMuxTerminalId}
												onSelect={selectTerminal}
											/>
										</Suspense>
									) : null}
									{settingsOpen ? (
										<Suspense fallback={null}>
											<SettingsOverlay
												open
												onOpenChange={setSettingsOpen}
												settings={appearanceSettings}
												onSettingsChange={setAppearanceSettings}
												keyboard={keyboardSettingsModel}
												themes={bundledThemeList}
												onReset={resetAppearanceSettings}
												servers={serverConnections.servers}
												serverConnections={serverConnections.snapshot.connections}
												currentServerId="current-host"
												onServersChange={serverConnections.updateServers}
												onTestServer={serverConnections.testServer}
											/>
										</Suspense>
									) : null}
									<CloseSessionDialog
										sessionId={closeChoice?.sessionId}
										sessionTitle={closingSessionTitle}
										onCancel={() => setCloseChoice(undefined)}
										onClose={(mode) =>
											closeChoice ? void closeSession(closeChoice.sessionId, mode) : undefined
										}
									/>
								</div>
							</div>
						</AmbientCanvas>
					</LayoutGroup>
				</TooltipProvider>
			</LazyMotion>
		</MotionConfig>
	);
}

function SidebarHoverToggle(props: {
	readonly side: "left" | "right";
	readonly collapsed: boolean;
	readonly onToggle: () => void;
}) {
	const left = props.side === "left";
	const Icon = left
		? props.collapsed
			? PanelLeftOpen
			: PanelLeftClose
		: props.collapsed
			? PanelRightOpen
			: PanelRightClose;
	const label = `${props.collapsed ? "Show" : "Hide"} sidebars`;
	return (
		<div
			className={cn(
				"group/sidebar-toggle absolute top-2 z-30 flex h-10 w-9 items-start",
				left ? "left-0 justify-start pl-1" : "right-0 justify-end pr-1",
			)}
			data-yaade-sidebar-hover-zone={props.side}
		>
			<Button
				type="button"
				size="icon-sm"
				variant="secondary"
				aria-label={label}
				title={label}
				data-yaade-sidebar-hover-toggle={props.side}
				className="opacity-0 shadow-sm transition-opacity duration-[var(--yaade-motion-fast)] group-hover/sidebar-toggle:opacity-100 focus-visible:opacity-100"
				onClick={props.onToggle}
			>
				<Icon />
			</Button>
		</div>
	);
}

function SelectedMuxTerminal(props: ProcessTerminalViewProps) {
	return (
		<Suspense
			fallback={
				<div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
					<Spinner />
					Opening terminal…
				</div>
			}
		>
			<TerminalRenderer {...props} />
		</Suspense>
	);
}

function CloseSessionDialog(props: {
	sessionId?: SessionId;
	sessionTitle?: string;
	onCancel: () => void;
	onClose: (mode: "keep-running" | "stop-terminals") => void;
}) {
	return (
		<Dialog
			open={Boolean(props.sessionId)}
			onOpenChange={(open) => {
				if (!open) props.onCancel();
			}}
		>
			<DialogContent size="picker">
				<DialogHeader>
					<DialogTitle>
						{props.sessionTitle ? `Close “${props.sessionTitle}”?` : "Close session?"}
					</DialogTitle>
					<DialogDescription>
						This removes the session from YAADE. Choose whether its terminals keep running on the
						host or stop now.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="flex-wrap">
					<Button variant="outline" onClick={props.onCancel}>
						Cancel
					</Button>
					<Button
						variant="outline"
						className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal text-center leading-normal"
						onClick={() => props.onClose("keep-running")}
					>
						Close and keep terminals running
					</Button>
					<Button
						variant="destructive"
						className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal text-center leading-normal"
						onClick={() => props.onClose("stop-terminals")}
					>
						Stop terminals and close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
