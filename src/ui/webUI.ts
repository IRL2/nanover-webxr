import { Controller } from 'lil-gui';
import {
  CustomPanel,
  formatSliderValue,
  getCustomPanels,
  getVariable,
  runPanelCommand,
  setVariable,
  subscribeCustomUI,
} from './customUI';

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
const NOTIFICATION_DURATION_MS = 4000;

let seekSlider: HTMLInputElement | null = null;
let playPauseBtn: HTMLButtonElement | null = null;
let refreshBtn: HTMLButtonElement | null = null;
let serverButtonsContainer: HTMLDivElement | null = null;
let webNotification: HTMLElement | null = null;
let webNotificationTimer: number | undefined;
let context: WebUIContext | null = null;
let availableServers: DiscoveryServerInfo[] = [];

export function setupWebUI(ctx: WebUIContext) {
    context = ctx;
    webNotification = document.getElementById('web-notification');

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

export function showWebNotification(message: string) {
    webNotification ??= document.getElementById('web-notification');
    if (!webNotification) return;

    webNotification.textContent = message;
    webNotification.classList.add('visible');
    if (webNotificationTimer !== undefined) {
        window.clearTimeout(webNotificationTimer);
    }
    webNotificationTimer = window.setTimeout(() => {
        webNotification?.classList.remove('visible');
        webNotificationTimer = undefined;
    }, NOTIFICATION_DURATION_MS);
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

    customPanelsContainer = document.getElementById('custom-panels-container') as HTMLDivElement | null;
    subscribeCustomUI((change) => {
        if (change === 'panels') {
            renderCustomPanels();
        } else {
            sliderUpdaters.forEach(update => update());
        }
    });
    renderCustomPanels();
}

let customPanelsContainer: HTMLDivElement | null = null;
let sliderUpdaters: (() => void)[] = [];

function renderCustomPanels() {
    if (!customPanelsContainer) return;
    sliderUpdaters = [];
    customPanelsContainer.replaceChildren(...getCustomPanels().map(buildCustomPanel));
}

function buildCustomPanel(panel: CustomPanel): HTMLElement {
    const section = document.createElement('div');
    section.className = 'custom-panel';

    const title = document.createElement('div');
    title.className = 'custom-panel-title';
    title.textContent = panel.label;
    section.appendChild(title);

    for (const element of panel.elements) {
        if (element.type === 'header') {
            const header = document.createElement('div');
            header.className = 'custom-panel-header';
            header.textContent = element.label;
            section.appendChild(header);
        } else if (element.type === 'button') {
            const button = document.createElement('button');
            button.className = 'panel-btn';
            button.textContent = element.label;
            button.addEventListener('click', () => {
                void runPanelCommand(element.command, element.arguments);
            });
            section.appendChild(button);
        } else {
            const row = document.createElement('label');
            row.className = 'custom-panel-slider';
            const text = document.createElement('span');
            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(element.min);
            input.max = String(element.max);
            input.step = String(element.step ?? (element.integer ? 1 : (element.max - element.min) / 100));
            const refresh = () => {
                const value = Number(getVariable(element.variable));
                text.textContent = `${element.label}: ${formatSliderValue(element, value)}`;
                if (Number.isFinite(value) && document.activeElement !== input) {
                    input.value = String(value);
                }
            };
            input.addEventListener('input', () => {
                const value = Number(input.value);
                setVariable(element.variable, element.integer ? Math.round(value) : value);
                text.textContent = `${element.label}: ${formatSliderValue(element, value)}`;
            });
            refresh();
            sliderUpdaters.push(refresh);
            row.append(text, input);
            section.appendChild(row);
        }
    }
    return section;
}

export function setWebConnected(connected: boolean) {
    document.getElementById('tab-controls')?.classList.toggle('connected', connected);
    if (connected) {
        document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="controls"]')?.click();
    }
}

type WebUserCommand = { name: string; label?: string; icon?: string };
let lastUserCommands: WebUserCommand[] = [];

async function runWebUserCommand(name: string) {
    const activeContext = context;
    if (!activeContext) return;

    showWebNotification(`Run ${name}`);
    const response = await activeContext.runCommand(name);
    if (response && typeof response === 'object') {
        const result = (response as Record<string, unknown>).result;
        if (result !== undefined) {
            showWebNotification(`${name}: ${String(result)}`);
        } else if (Object.keys(response).length > 0) {
            showWebNotification(`Completed ${name}`);
        }
    }
}

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
            void runWebUserCommand(command.name);
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
            window.onmessage = () => {context?.connectToServer(server.wss); window.onmessage = null; };
            window.open(server.https);
        });

        serverButtonsContainer.appendChild(serverButton);
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
