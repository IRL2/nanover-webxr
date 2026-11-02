import { Controller } from 'lil-gui';

export interface WebUIContext {
    getFrameSeek: () => Controller;
    getFramePlay: () => Controller;
    updateTrajectoryName: (name: string) => void;
    connectToServer: (host: string) => void;
    runCommand: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
    setCartoonStyle: (style: 'simple' | 'advanced') => void;
}

type DiscoveryServerInfo = { name: string; wss: string; https?: string };
type DiscoveryResponseItem = { info: DiscoveryServerInfo };

const DISCOVERY_LIST_URL = 'https://irl-discovery.onrender.com/list';

let seekSlider: HTMLInputElement | null = null;
let playPauseBtn: HTMLButtonElement | null = null;
let refreshBtn: HTMLButtonElement | null = null;
let serverButtonsContainer: HTMLDivElement | null = null;
let context: WebUIContext | null = null;
let availableServers: DiscoveryServerInfo[] = [];

export function setupWebUI(ctx: WebUIContext) {
    context = ctx;

    // tab switching
    const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
    const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const target = document.getElementById(`tab-${btn.dataset.tab}`);
            if (target) target.classList.add('active');
        });
    });

    // play / pause
    playPauseBtn = document.getElementById('btn-play-pause') as HTMLButtonElement | null;
    if (playPauseBtn) {
        playPauseBtn.addEventListener('click', () => {
            if (!context) return;
            const fp = context.getFramePlay();
            fp.setValue(!fp.getValue());
            syncPlayPauseLabel();
        });
    }

    seekSlider = document.getElementById('seek-slider') as HTMLInputElement | null;
    if (seekSlider) {
        seekSlider.addEventListener('input', () => {
            if (!context || !seekSlider) return;
            const fp = context.getFramePlay();
            const fs = context.getFrameSeek();
            fp.setValue(false);
            fs.setValue(Number(seekSlider.value));
            syncPlayPauseLabel();
        });
    }

    const cartoonSelect = document.getElementById('cartoon-style-select') as HTMLSelectElement | null;
    if (cartoonSelect) {
        context.setCartoonStyle(cartoonSelect.value as 'simple' | 'advanced');
        cartoonSelect.addEventListener('change', () => {
            context?.setCartoonStyle(cartoonSelect.value as 'simple' | 'advanced');
        });
    }

    // server functionality
    setupServerTab();
    setupControlsTab();
}

let controlsPlaying = false;
let userCommandsContainer: HTMLDivElement | null = null;

function setupControlsTab() {
    userCommandsContainer = document.getElementById('user-commands-container') as HTMLDivElement | null;
    const playBtn = document.getElementById('btn-ctrl-play') as HTMLButtonElement | null;

    document.getElementById('btn-ctrl-restart')?.addEventListener('click', () => {
        void context?.runCommand('playback/reset');
    });
    document.getElementById('btn-ctrl-step')?.addEventListener('click', () => {
        void context?.runCommand('playback/step');
    });
    playBtn?.addEventListener('click', () => {
        controlsPlaying = !controlsPlaying;
        playBtn.textContent = controlsPlaying ? 'Pause' : 'Play';
        void context?.runCommand(controlsPlaying ? 'playback/play' : 'playback/pause');
    });

    setWebUserCommands(lastUserCommands);
}

export function setWebConnected(connected: boolean) {
    document.getElementById('tab-controls')?.classList.toggle('connected', connected);
    if (connected) {
        document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="controls"]')?.click();
    }
}

type WebUserCommand = { name: string; label?: string; icon?: string };
let lastUserCommands: WebUserCommand[] = [];

export function setWebUserCommands(commands: WebUserCommand[]) {
    lastUserCommands = commands;
    if (!userCommandsContainer) return;
    userCommandsContainer.replaceChildren();
    for (const command of commands) {
        const button = document.createElement('button');
        button.className = 'panel-btn';
        const label = command.label ?? command.name.split('/').slice(1).join(' ');
        button.textContent = command.icon ? `${command.icon} ${label}` : label;
        button.addEventListener('click', () => {
            void context?.runCommand(command.name);
        });
        userCommandsContainer.appendChild(button);
    }
}

function setupServerTab() {
    refreshBtn = document.getElementById('btn-refresh') as HTMLButtonElement | null;
    serverButtonsContainer = document.getElementById('server-buttons-container') as HTMLDivElement | null;
    if (!refreshBtn || !serverButtonsContainer) return;

    refreshBtn.addEventListener('click', () => {
        void refreshServerList();
    });

    void refreshServerList();
}

async function refreshServerList() {
    if (!serverButtonsContainer || !refreshBtn) return;

    setRefreshLoading(true);
    renderServerStatus('Loading servers...');

    try {
        const response = await fetch(DISCOVERY_LIST_URL);
        if (!response.ok) {
            throw new Error(`Discovery request failed with status ${response.status}`);
        }

        const list = await response.json() as DiscoveryResponseItem[];
        availableServers = list.map(item => item.info);
        renderServerButtons(availableServers);
    } catch (error) {
        availableServers = [];
        console.error('Error fetching server list:', error);
        renderServerStatus('Error loading servers', 'error');
    } finally {
        setRefreshLoading(false);
    }
}

function renderServerButtons(servers: DiscoveryServerInfo[]) {
    if (!serverButtonsContainer) return;

    serverButtonsContainer.replaceChildren();
    if (servers.length === 0) {
        renderServerStatus('No servers available');
        return;
    }

    for (const server of servers) {
        const serverButton = document.createElement('button');
        serverButton.className = 'panel-btn server-btn';
        serverButton.textContent = server.name;
        serverButton.addEventListener('click', () => {
            context?.connectToServer(server.wss);
        });

        const row = document.createElement('div');
        row.className = 'server-row';
        row.appendChild(serverButton);

        if (server.https) {
            const certLink = document.createElement('a');
            certLink.className = 'panel-btn cert-btn';
            certLink.textContent = 'CERT';
            certLink.href = server.https;
            certLink.target = '_blank';
            certLink.rel = 'noopener noreferrer';
            row.appendChild(certLink);
        }
        serverButtonsContainer.appendChild(row);
    }
}

function renderServerStatus(message: string, variant: 'default' | 'error' = 'default') {
    if (!serverButtonsContainer) return;

    const status = document.createElement('p');
    status.className = variant === 'error' ? 'server-status server-status-error' : 'server-status';
    status.textContent = message;
    serverButtonsContainer.replaceChildren(status);
}

function setRefreshLoading(isLoading: boolean) {
    if (!refreshBtn) return;

    refreshBtn.disabled = isLoading;
    refreshBtn.textContent = isLoading ? 'Refreshing...' : 'Refresh';
}

function syncPlayPauseLabel() {
    if (!playPauseBtn || !context) return;
    const isPlaying = context.getFramePlay().getValue();
    playPauseBtn.textContent = isPlaying ? 'Pause' : 'Play';
}

export function updateWebUI(currentFrame: number, maxFrames: number) {
    if (seekSlider) {
        seekSlider.max = String(Math.max(0, maxFrames - 1));
        seekSlider.value = String(currentFrame);
    }
    syncPlayPauseLabel();
}
