/**
 * Archive extension
 *
 * Adds /archive and /unarchive commands for multi-select session management.
 *
 * Controls:
 * - Enter: toggle selection on the highlighted session
 * - Ctrl+D: apply action to all selected sessions, or the highlighted session if none selected
 * - Tab: toggle current-folder/all-sessions scope
 * - Ctrl+P: toggle full path display
 * - Esc/Ctrl+C: close
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, SessionInfo } from "@mariozechner/pi-coding-agent";
import { getAgentDir, SessionManager } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";

const AGENT_DIR = getAgentDir();
const DEFAULT_SESSION_DIR = join(AGENT_DIR, "sessions");
const ARCHIVE_DIR = join(AGENT_DIR, "session-archive");
const MAX_VISIBLE = 12;

type SessionScope = "current" | "all";
type StatusMessage = { type: "info" | "error"; message: string } | null;
type Mode = "archive" | "unarchive";

interface SessionManagerUIOptions {
	title: string;
	actionVerb: string;
	currentScopeLabel: string;
	allScopeLabel: string;
	archiveDirMode: boolean;
}

const MODE_OPTIONS: Record<Mode, SessionManagerUIOptions> = {
	archive: {
		title: "Archive Session",
		actionVerb: "archive",
		currentScopeLabel: "Current Folder",
		allScopeLabel: "All Sessions",
		archiveDirMode: false,
	},
	unarchive: {
		title: "Unarchive Session",
		actionVerb: "unarchive",
		currentScopeLabel: "Current Folder Archive",
		allScopeLabel: "All Archived Sessions",
		archiveDirMode: true,
	},
};

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shortenPath(path: string): string {
	if (path.startsWith(AGENT_DIR)) {
		return `~/.pi/agent${path.slice(AGENT_DIR.length)}`;
	}
	return path;
}

function formatAge(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function getDefaultSessionDirForCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(DEFAULT_SESSION_DIR, safePath);
}

async function readSessionHeader(sessionPath: string): Promise<{ cwd?: string } | null> {
	try {
		const content = await readFile(sessionPath, "utf8");
		const firstLine = content
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		if (!firstLine) {
			return null;
		}
		return JSON.parse(firstLine) as { cwd?: string };
	} catch {
		return null;
	}
}

function getArchiveDestination(sessionPath: string, sessionDir: string): string {
	if (isWithin(DEFAULT_SESSION_DIR, sessionPath)) {
		return join(ARCHIVE_DIR, relative(DEFAULT_SESSION_DIR, sessionPath));
	}

	if (isWithin(sessionDir, sessionPath)) {
		return join(ARCHIVE_DIR, relative(sessionDir, sessionPath));
	}

	return join(ARCHIVE_DIR, basename(sessionPath));
}

async function getUnarchiveDestination(sessionPath: string): Promise<string> {
	if (isWithin(ARCHIVE_DIR, sessionPath)) {
		const archivedRelativePath = relative(ARCHIVE_DIR, sessionPath);
		if (dirname(archivedRelativePath) !== ".") {
			return join(DEFAULT_SESSION_DIR, archivedRelativePath);
		}
	}

	const header = await readSessionHeader(sessionPath);
	if (header?.cwd) {
		return join(getDefaultSessionDirForCwd(header.cwd), basename(sessionPath));
	}

	return join(DEFAULT_SESSION_DIR, basename(sessionPath));
}

function getUniqueDestination(destinationPath: string): string {
	if (!existsSync(destinationPath)) {
		return destinationPath;
	}

	const extension = extname(destinationPath);
	const base = destinationPath.slice(0, destinationPath.length - extension.length);
	let index = 1;

	while (true) {
		const candidate = `${base}-${index}${extension}`;
		if (!existsSync(candidate)) {
			return candidate;
		}
		index++;
	}
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
	await mkdir(dirname(destinationPath), { recursive: true });

	try {
		await rename(sourcePath, destinationPath);
	} catch (error: unknown) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EXDEV") {
			throw error;
		}
		await copyFile(sourcePath, destinationPath);
		await unlink(sourcePath);
	}
}

async function archiveSessionFile(sessionPath: string, sessionDir: string): Promise<void> {
	const destinationPath = getUniqueDestination(getArchiveDestination(sessionPath, sessionDir));
	await moveFile(sessionPath, destinationPath);
}

async function unarchiveSessionFile(sessionPath: string): Promise<void> {
	const destinationPath = getUniqueDestination(await getUnarchiveDestination(sessionPath));
	await moveFile(sessionPath, destinationPath);
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
	if (!existsSync(dir)) {
		return [];
	}

	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				return walkJsonlFiles(fullPath);
			}
			return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
		}),
	);
	return files.flat();
}

async function readArchivedSessionInfo(sessionPath: string): Promise<SessionInfo | null> {
	try {
		const content = await readFile(sessionPath, "utf8");
		const lines = content.split("\n").filter((line) => line.trim().length > 0);
		if (lines.length === 0) {
			return null;
		}

		const header = JSON.parse(lines[0]!) as { cwd?: string; id?: string; timestamp?: string };
		let name: string | undefined;
		let firstMessage = "";
		let allMessagesText = "";
		let messageCount = 0;
		let modified = header.timestamp ? new Date(header.timestamp) : new Date(0);

		for (const line of lines.slice(1)) {
			const entry = JSON.parse(line) as {
				timestamp?: string;
				type?: string;
				name?: string;
				message?: {
					role?: string;
					content?: string | Array<{ type?: string; text?: string }>;
				};
			};
			if (entry.timestamp) {
				modified = new Date(entry.timestamp);
			}
			if (entry.type === "session_info" && typeof entry.name === "string") {
				name = entry.name;
			}
			if (entry.type !== "message" || !entry.message) {
				continue;
			}
			messageCount++;
			const contentText =
				typeof entry.message.content === "string"
					? entry.message.content
					: entry.message.content
							.filter((part) => part.type === "text" && typeof part.text === "string")
							.map((part) => part.text)
							.join(" ");
			if (!firstMessage && entry.message.role === "user") {
				firstMessage = contentText;
			}
			allMessagesText += `${contentText}\n`;
		}

		return {
			path: sessionPath,
			id: header.id ?? basename(sessionPath, ".jsonl"),
			cwd: header.cwd ?? "",
			name,
			created: header.timestamp ? new Date(header.timestamp) : modified,
			modified,
			messageCount,
			firstMessage: firstMessage || name || basename(sessionPath),
			allMessagesText: allMessagesText.trim(),
		};
	} catch {
		return null;
	}
}

async function listArchivedSessions(cwd?: string): Promise<SessionInfo[]> {
	const files = await walkJsonlFiles(ARCHIVE_DIR);
	const sessions = (await Promise.all(files.map((file) => readArchivedSessionInfo(file)))).filter(
		(session): session is SessionInfo => session !== null,
	);
	const filtered = cwd ? sessions.filter((session) => session.cwd === cwd) : sessions;
	return filtered.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) {
		return [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}

	return sessions
		.filter((session) => {
			const haystack = `${session.name ?? ""} ${session.firstMessage} ${session.cwd} ${session.path}`.toLowerCase();
			return haystack.includes(trimmed);
		})
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

class SessionManagerSelector extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly selectedPaths = new Set<string>();
	private readonly currentSessionsLoader: () => Promise<SessionInfo[]>;
	private readonly allSessionsLoader: () => Promise<SessionInfo[]>;
	private readonly applyToSessions: (sessionPaths: string[]) => Promise<{ processed: number; failed: number }>;
	private readonly currentSessionPath?: string;
	private readonly onDone: () => void;
	private readonly requestRender: () => void;
	private readonly options: SessionManagerUIOptions;

	private _focused = false;
	private scope: SessionScope = "current";
	private showPath = false;
	private selectedIndex = 0;
	private loading = true;
	private processing = false;
	private statusMessage: StatusMessage = null;
	private currentSessions: SessionInfo[] = [];
	private allSessions: SessionInfo[] = [];
	private visibleSessions: SessionInfo[] = [];

	constructor(options: {
		currentSessionsLoader: () => Promise<SessionInfo[]>;
		allSessionsLoader: () => Promise<SessionInfo[]>;
		applyToSessions: (sessionPaths: string[]) => Promise<{ processed: number; failed: number }>;
		currentSessionPath?: string;
		onDone: () => void;
		requestRender: () => void;
		ui: SessionManagerUIOptions;
	}) {
		super();
		this.currentSessionsLoader = options.currentSessionsLoader;
		this.allSessionsLoader = options.allSessionsLoader;
		this.applyToSessions = options.applyToSessions;
		this.currentSessionPath = options.currentSessionPath;
		this.onDone = options.onDone;
		this.requestRender = options.requestRender;
		this.options = options.ui;
		this.searchInput.onSubmit = () => {
			this.toggleHighlighted();
			this.requestRender();
		};
		void this.loadCurrentSessions();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private async loadCurrentSessions(): Promise<void> {
		this.loading = true;
		this.statusMessage = null;
		this.requestRender();
		try {
			this.currentSessions = await this.currentSessionsLoader();
			this.refreshVisibleSessions();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.statusMessage = { type: "error", message: `Failed to load sessions: ${message}` };
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private async ensureAllSessionsLoaded(): Promise<void> {
		this.loading = true;
		this.statusMessage = null;
		this.requestRender();
		try {
			this.allSessions = await this.allSessionsLoader();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.statusMessage = { type: "error", message: `Failed to load sessions: ${message}` };
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private getScopedSessions(): SessionInfo[] {
		return this.scope === "all" ? this.allSessions : this.currentSessions;
	}

	private refreshVisibleSessions(): void {
		this.visibleSessions = filterSessions(this.getScopedSessions(), this.searchInput.getValue());
		if (this.selectedIndex >= this.visibleSessions.length) {
			this.selectedIndex = Math.max(0, this.visibleSessions.length - 1);
		}
		this.pruneSelection();
	}

	private pruneSelection(): void {
		const available = new Set(this.getScopedSessions().map((session) => session.path));
		for (const path of this.selectedPaths) {
			if (!available.has(path)) {
				this.selectedPaths.delete(path);
			}
		}
	}

	private getHighlightedSession(): SessionInfo | undefined {
		return this.visibleSessions[this.selectedIndex];
	}

	private isProtected(session: SessionInfo): boolean {
		return !this.options.archiveDirMode && this.currentSessionPath === session.path;
	}

	private toggleHighlighted(): void {
		const session = this.getHighlightedSession();
		if (!session) return;
		if (this.isProtected(session)) {
			this.statusMessage = { type: "error", message: `Cannot ${this.options.actionVerb} the currently active session` };
			return;
		}
		if (this.selectedPaths.has(session.path)) {
			this.selectedPaths.delete(session.path);
		} else {
			this.selectedPaths.add(session.path);
		}
		this.statusMessage = null;
	}

	private async toggleScope(): Promise<void> {
		if (this.scope === "current") {
			this.scope = "all";
			await this.ensureAllSessionsLoaded();
		} else {
			this.scope = "current";
		}

		this.refreshVisibleSessions();
		this.requestRender();
	}

	private removeProcessedSessions(paths: Set<string>): void {
		this.currentSessions = this.currentSessions.filter((session) => !paths.has(session.path));
		this.allSessions = this.allSessions.filter((session) => !paths.has(session.path));
		for (const path of paths) {
			this.selectedPaths.delete(path);
		}
		this.refreshVisibleSessions();
	}

	private async applySelected(): Promise<void> {
		if (this.processing) return;

		const selected = this.selectedPaths.size > 0 ? [...this.selectedPaths] : [];
		if (selected.length === 0) {
			const highlighted = this.getHighlightedSession();
			if (!highlighted) return;
			if (this.isProtected(highlighted)) {
				this.statusMessage = {
					type: "error",
					message: `Cannot ${this.options.actionVerb} the currently active session`,
				};
				this.requestRender();
				return;
			}
			selected.push(highlighted.path);
		}

		this.processing = true;
		this.statusMessage = {
			type: "info",
			message: `${this.options.actionVerb[0]!.toUpperCase()}${this.options.actionVerb.slice(1)} ${selected.length} session${selected.length === 1 ? "" : "s"}...`,
		};
		this.requestRender();

		try {
			const result = await this.applyToSessions(selected);
			this.removeProcessedSessions(new Set(selected));
			if (result.failed > 0) {
				this.statusMessage = {
					type: "error",
					message: `${this.options.actionVerb[0]!.toUpperCase()}${this.options.actionVerb.slice(1)}d ${result.processed}, failed ${result.failed}`,
				};
			} else {
				this.statusMessage = {
					type: "info",
					message: `${this.options.actionVerb[0]!.toUpperCase()}${this.options.actionVerb.slice(1)}d ${result.processed} session${result.processed === 1 ? "" : "s"}`,
				};
			}
		} finally {
			this.processing = false;
			this.requestRender();
		}
	}

	override handleInput(data: string): void {
		if (this.processing) {
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			void this.toggleScope();
			return;
		}

		if (matchesKey(data, Key.ctrl("p"))) {
			this.showPath = !this.showPath;
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.ctrl("d"))) {
			void this.applySelected();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.visibleSessions.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}

		this.searchInput.handleInput(data);
		this.refreshVisibleSessions();
		this.requestRender();
	}

	override render(width: number): string[] {
		this.clear();
		this.addChild(new Text(this.options.title, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		const scopeText = this.scope === "current" ? this.options.currentScopeLabel : this.options.allScopeLabel;
		const selectedCount = this.selectedPaths.size;
		const summary = `${scopeText} · selected ${selectedCount} · ctrl+d ${this.options.actionVerb} · enter toggle · tab scope · ctrl+p path`;
		this.addChild(new Text(truncateToWidth(summary, Math.max(0, width - 2), "…"), 1, 0));
		this.addChild(new Spacer(1));

		if (this.loading) {
			this.addChild(new Text("Loading...", 1, 0));
		} else if (this.visibleSessions.length === 0) {
			this.addChild(new Text("No sessions found", 1, 0));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.visibleSessions.length - MAX_VISIBLE),
			);
			const endIndex = Math.min(this.visibleSessions.length, startIndex + MAX_VISIBLE);

			for (let index = startIndex; index < endIndex; index++) {
				const session = this.visibleSessions[index]!;
				const highlighted = index === this.selectedIndex;
				const selected = this.selectedPaths.has(session.path);
				const protectedSession = this.isProtected(session);
				const mark = protectedSession ? "[-]" : selected ? "[x]" : "[ ]";
				const cursor = highlighted ? "> " : "  ";
				const name = (session.name ?? session.firstMessage).replace(/[\x00-\x1f\x7f]/g, " ").trim() || "(empty)";
				const meta = `${session.messageCount} ${formatAge(session.modified)}`;
				const pathText = this.showPath ? shortenPath(session.path) : shortenPath(session.cwd);
				const leftPrefix = `${cursor}${mark} ${name}`;
				const rightText = `${pathText} ${meta}`;
				const available = Math.max(8, width - visibleWidth(rightText) - 5);
				const leftText = truncateToWidth(leftPrefix, available, "…");
				const spacing = Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText));
				let line = `${leftText}${" ".repeat(spacing)}${rightText}`;
				if (highlighted) {
					line = `\u001b[7m${truncateToWidth(line, width)}\u001b[27m`;
				} else {
					line = truncateToWidth(line, width);
				}
				this.addChild(new Text(line, 0, 0));
			}

			if (this.visibleSessions.length > MAX_VISIBLE) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(`(${this.selectedIndex + 1}/${this.visibleSessions.length})`, 1, 0));
			}
		}

		if (this.statusMessage) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(this.statusMessage.message, 1, 0));
		}

		return super.render(width);
	}
}

function createCurrentArchiveLoader(cwd: string): () => Promise<SessionInfo[]> {
	return () => listArchivedSessions(cwd);
}

function createAllArchiveLoader(): () => Promise<SessionInfo[]> {
	return () => listArchivedSessions();
}

export default function archiveExtension(pi: ExtensionAPI) {
	const register = (command: Mode) => {
		const ui = MODE_OPTIONS[command];

		pi.registerCommand(command, {
			description: `${ui.actionVerb[0]!.toUpperCase()}${ui.actionVerb.slice(1)} sessions without resuming them`,
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify(`${command} requires interactive mode`, "error");
					return;
				}

				const sessionDir = ctx.sessionManager.getSessionDir();
				const currentSessionPath = ctx.sessionManager.getSessionFile();
				const currentSessionsLoader =
					command === "archive"
						? () => SessionManager.list(ctx.sessionManager.getCwd(), sessionDir)
						: createCurrentArchiveLoader(ctx.sessionManager.getCwd());
				const allSessionsLoader =
					command === "archive" ? () => SessionManager.listAll() : createAllArchiveLoader();

				await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
					const selector = new SessionManagerSelector({
						currentSessionsLoader,
						allSessionsLoader,
						applyToSessions: async (sessionPaths) => {
							let processed = 0;
							let failed = 0;

							for (const sessionPath of sessionPaths) {
								try {
									if (command === "archive") {
										await archiveSessionFile(sessionPath, sessionDir);
									} else {
										await unarchiveSessionFile(sessionPath);
									}
									processed++;
								} catch {
									failed++;
								}
							}

							return { processed, failed };
						},
						currentSessionPath,
						onDone: () => done(undefined),
						requestRender: () => tui.requestRender(),
						ui,
					});

					tui.setFocus(selector);
					return selector;
				});
			},
		});
	};

	register("archive");
	register("unarchive");
}
