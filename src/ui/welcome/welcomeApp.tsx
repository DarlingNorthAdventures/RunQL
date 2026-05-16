import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// Type extension for VS Code webview API
declare const acquireVsCodeApi: () => {
    postMessage: (message: any) => void;
    getState: () => any;
    setState: (state: any) => void;
};

const vscode = acquireVsCodeApi();

type InitStructureEntry = {
    folder: string;
    files: string[];
};

type StructureIconKind = 'folder' | 'file';
type WelcomeMode = 'welcome' | 'whatsNew';

type AISettingDoc = {
    name: string;
    summary: string;
    details: string;
};

// Folder + default file structure that Initialize creates
const INIT_STRUCTURE: InitStructureEntry[] = [
    { folder: '(project root)', files: ['AGENTS.md (or AGENTS_RUNQL.md)', 'README_RUNQL.md'] },
    { folder: 'RunQL', files: [] },
    { folder: 'RunQL/queries', files: [] },
    { folder: 'RunQL/schemas', files: ['<connection>/schema.json', '<connection>/description.json', '<connection>/custom.relationships.json', '<connection>/erd.json', '<connection>/erd.layout.json'] },
    { folder: 'RunQL/system', files: [] },
    { folder: 'RunQL/system/queries', files: ['queryIndex.json', 'queryHistory.json (after first query run)'] },
    {
        folder: 'RunQL/system/prompts',
        files: ['markdownDoc.txt', 'inlineComments.txt', 'describeSchema.txt']
    }
];

const AI_SETTINGS: AISettingDoc[] = [
    {
        name: 'AI Source',
        summary: 'Choose how RunQL should access AI.',
        details: 'Use GitHub Copilot / VS Code AI for the built-in VS Code path, AI Extension for Claude Code or Codex handoff, Direct API for your own provider, or Off to disable AI.'
    },
    {
        name: 'AI Extension',
        summary: 'Pick the extension RunQL should use when AI Source is AI Extension.',
        details: 'Choose Claude Code or Codex. Leave it on Automatic if you want RunQL to choose from supported installed extensions.'
    },
    {
        name: 'API Provider',
        summary: 'Choose the provider for Direct API.',
        details: 'Use OpenAI, Anthropic, Azure OpenAI, Ollama, or OpenAI-Compatible depending on where your model lives.'
    },
    {
        name: 'AI Model',
        summary: 'Choose a model when your AI source supports it.',
        details: 'This is used by GitHub Copilot / VS Code AI and Direct API. It is ignored for AI Extension.'
    },
    {
        name: 'API Base URL',
        summary: 'Enter a custom base URL only when your provider needs one.',
        details: 'This is usually required for Azure OpenAI and OpenAI-compatible servers, and optional for Ollama if you are not using the default local URL.'
    }
];

// Styles
const styles: Record<string, React.CSSProperties> = {
    container: {
        fontFamily: 'var(--vscode-font-family)',
        color: 'var(--vscode-foreground)',
        backgroundColor: 'var(--vscode-editor-background)',
        padding: '24px',
        maxWidth: '800px',
        margin: '0 auto'
    },
    header: {
        marginBottom: '24px',
        borderBottom: '1px solid var(--vscode-panel-border)',
        paddingBottom: '16px'
    },
    title: {
        fontSize: '24px',
        fontWeight: 600,
        margin: 0,
        marginBottom: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
    },
    trustStatement: {
        fontSize: '13px',
        color: 'var(--vscode-descriptionForeground)',
        margin: 0,
        padding: '8px 12px',
        backgroundColor: 'var(--vscode-textBlockQuote-background)',
        borderLeft: '3px solid var(--vscode-textLink-activeForeground)',
        borderRadius: '2px'
    },
    card: {
        backgroundColor: 'var(--vscode-sideBar-background)',
        border: '1px solid var(--vscode-panel-border)',
        borderRadius: '6px',
        padding: '16px',
        marginBottom: '16px'
    },
    cardTitle: {
        fontSize: '14px',
        fontWeight: 600,
        marginBottom: '12px',
        marginTop: 0,
        marginLeft: 0,
        marginRight: 0
    },
    statusBadge: {
        display: 'inline-block',
        padding: '4px 12px',
        borderRadius: '12px',
        fontSize: '12px',
        fontWeight: 500
    },
    statusInitialized: {
        backgroundColor: 'var(--vscode-testing-iconPassed)',
        color: 'var(--vscode-editor-background)'
    },
    statusNotInitialized: {
        backgroundColor: 'var(--vscode-testing-iconFailed)',
        color: 'var(--vscode-editor-background)'
    },
    button: {
        padding: '8px 16px',
        fontSize: '13px',
        fontWeight: 500,
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer',
        marginRight: '8px',
        marginBottom: '8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px'
    },
    primaryButton: {
        backgroundColor: 'var(--vscode-button-background)',
        color: 'var(--vscode-button-foreground)'
    },
    secondaryButton: {
        backgroundColor: 'var(--vscode-button-secondaryBackground)',
        color: 'var(--vscode-button-secondaryForeground)'
    },
    folderList: {
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: '8px'
    },
    folderItem: {
        padding: '8px',
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        borderRadius: '3px'
    },
    folderName: {
        fontSize: '12px',
        fontFamily: 'var(--vscode-editor-font-family)',
        fontWeight: 600
    },
    fileList: {
        margin: '6px 0 0 0',
        padding: 0,
        listStyle: 'none'
    },
    fileItem: {
        fontSize: '12px',
        fontFamily: 'var(--vscode-editor-font-family)',
        color: 'var(--vscode-descriptionForeground)',
        marginTop: '2px'
    },
    emptyFolder: {
        marginTop: '6px',
        fontSize: '12px',
        color: 'var(--vscode-descriptionForeground)',
        fontStyle: 'italic'
    },
    linkList: {
        margin: 0,
        padding: 0,
        listStyle: 'none'
    },
    link: {
        color: 'var(--vscode-textLink-foreground)',
        textDecoration: 'none',
        cursor: 'pointer',
        fontSize: '13px',
        display: 'block',
        padding: '4px 0'
    },
    inlineLink: {
        color: 'var(--vscode-textLink-foreground)',
        textDecoration: 'none',
        cursor: 'pointer'
    },
    statusPanel: {
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        borderRadius: '4px',
        padding: '12px'
    },
    statusNote: {
        marginTop: 0,
        marginBottom: '12px',
        fontSize: '13px',
        color: 'var(--vscode-descriptionForeground)'
    },
    actionRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        alignItems: 'center'
    },
    stepAction: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '6px',
        minWidth: '220px'
    },
    stepLabel: {
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.08em',
        color: 'var(--vscode-descriptionForeground)'
    },
    stepStateComplete: {
        fontSize: '12px',
        fontWeight: 600,
        color: 'var(--vscode-testing-iconPassed)'
    },
    stepStatePending: {
        fontSize: '12px',
        color: 'var(--vscode-descriptionForeground)'
    },
    stepCompleteIcon: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        height: '18px',
        marginLeft: '4px',
        borderRadius: '999px',
        fontSize: '12px',
        fontWeight: 700,
        lineHeight: 1
    },
    stepCompleteIconActive: {
        backgroundColor: 'var(--vscode-testing-iconPassed)',
        color: 'var(--vscode-editor-background)'
    },
    stepCompleteIconPending: {
        backgroundColor: 'var(--vscode-disabledForeground)',
        color: 'var(--vscode-editor-background)',
        opacity: 0.75
    },
    structureLabel: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px'
    },
    structureIcon: {
        width: '14px',
        height: '14px',
        color: 'var(--vscode-descriptionForeground)',
        flex: '0 0 auto'
    },
    lead: {
        marginTop: '10px',
        marginBottom: 0,
        fontSize: '14px',
        color: 'var(--vscode-descriptionForeground)',
        lineHeight: 1.5
    },
    callout: {
        marginTop: '12px',
        padding: '12px 14px',
        backgroundColor: 'var(--vscode-textBlockQuote-background)',
        borderLeft: '3px solid var(--vscode-textLink-activeForeground)',
        borderRadius: '4px',
        fontSize: '13px',
        lineHeight: 1.5
    },
    settingsGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '10px'
    },
    settingCard: {
        padding: '12px',
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        borderRadius: '4px',
        border: '1px solid var(--vscode-panel-border)'
    },
    settingName: {
        margin: 0,
        marginBottom: '6px',
        fontSize: '13px',
        fontWeight: 700
    },
    settingSummary: {
        margin: 0,
        marginBottom: '6px',
        fontSize: '13px'
    },
    settingDetails: {
        margin: 0,
        fontSize: '12px',
        color: 'var(--vscode-descriptionForeground)',
        lineHeight: 1.45
    },
    bulletList: {
        margin: '10px 0 0 18px',
        padding: 0,
        color: 'var(--vscode-descriptionForeground)',
        fontSize: '13px',
        lineHeight: 1.5
    }
};

function StructureIcon({ kind }: { kind: StructureIconKind }) {
    if (kind === 'folder') {
        return (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={styles.structureIcon}>
                <path
                    d="M1.75 4.5a1.25 1.25 0 0 1 1.25-1.25h3.1l1.2 1.5H13a1.25 1.25 0 0 1 1.25 1.25v5.5A1.25 1.25 0 0 1 13 12.75H3A1.25 1.25 0 0 1 1.75 11.5v-7Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                />
            </svg>
        );
    }

    return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={styles.structureIcon}>
            <path
                d="M4 1.75h5.5l2.5 2.5v9A1.25 1.25 0 0 1 10.75 14.5h-6.5A1.25 1.25 0 0 1 3 13.25v-10A1.5 1.5 0 0 1 4.5 1.75Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
            />
            <path d="M9.5 1.75v2.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
    );
}

function App() {
    const [initialized, setInitialized] = useState<boolean | null>(null);
    const [hasWorkspace, setHasWorkspace] = useState<boolean | null>(null);
    const [mode, setMode] = useState<WelcomeMode>('welcome');
    const [version, setVersion] = useState<string>('');

    useEffect(() => {
        // Listen for messages from extension
        const handler = (event: MessageEvent) => {
            const message = event.data;
            if (message.command === 'setStatus') {
                setInitialized(message.initialized);
                setHasWorkspace(message.hasWorkspace);
                setMode((message.mode as WelcomeMode) || 'welcome');
                setVersion((message.version as string) || '');
            }
        };
        window.addEventListener('message', handler);

        // Signal ready
        vscode.postMessage({ command: 'ready' });

        return () => window.removeEventListener('message', handler);
    }, []);

    const handleInitialize = () => {
        if (!hasWorkspace) {
            return;
        }
        vscode.postMessage({ command: 'initialize' });
    };

    const handleOpenFolder = () => {
        vscode.postMessage({ command: 'openFolder' });
    };

    const handleAddConnection = () => {
        vscode.postMessage({ command: 'addConnection' });
    };

    const handleOpenSettings = () => {
        vscode.postMessage({ command: 'openSettings' });
    };

    const handleOpenReadme = () => {
        vscode.postMessage({ command: 'openReadme' });
    };

    const step1Complete = hasWorkspace === true;
    const step2Complete = initialized === true;
    const step1Active = hasWorkspace === false;
    const step2Active = hasWorkspace === true && initialized === false;
    const isWhatsNew = mode === 'whatsNew';

    return (
        <div style={styles.container}>
            {/* Header */}
            <div style={styles.header}>
                <h1 style={styles.title}>
                    {isWhatsNew ? "What's New in RunQL" : 'RunQL'}
                </h1>
                {isWhatsNew ? (
                    <>
                        <p style={styles.lead}>
                            {version ? `Version ${version} includes a simpler AI settings model.` : 'This update includes a simpler AI settings model.'}
                        </p>
                        <div style={styles.callout}>
                            RunQL now groups AI setup around five settings: AI Source, AI Extension, API Provider, AI Model, and API Base URL.
                        </div>
                    </>
                ) : (
                    <p style={styles.trustStatement}>
                        RunQL will not create project files until you click Initialize.
                    </p>
                )}
            </div>

            {isWhatsNew && (
                <div style={styles.card}>
                    <h2 style={styles.cardTitle}>AI Settings Have Changed</h2>
                    <p style={{ ...styles.statusNote, marginBottom: '8px' }}>
                        The old backend and broker terminology has been removed from Settings. RunQL now uses a simpler AI setup model.
                    </p>
                    <ul style={styles.bulletList}>
                        <li>Use <strong>GitHub Copilot / VS Code AI</strong> when you want RunQL to use the VS Code-native AI path.</li>
                        <li>Use <strong>AI Extension</strong> when you want Claude Code or Codex to handle supported AI tasks.</li>
                        <li>Use <strong>Direct API</strong> when you want to connect OpenAI, Anthropic, Azure OpenAI, Ollama, or another compatible endpoint.</li>
                    </ul>
                    <p style={{ ...styles.statusNote, marginTop: '8px', marginBottom: 0 }}>
                        Learn more in the <a href="#ai-settings-guide" style={styles.inlineLink}>
                            AI Settings Guide
                        </a> below.
                    </p>
                </div>
            )}

            {/* Workspace Status */}
            <div style={styles.card}>
                <h2 style={styles.cardTitle}><span style={{ marginRight: '4px' }}>Workspace Status </span>
                    {initialized === null ? (
                        <span style={{ ...styles.statusBadge, backgroundColor: 'var(--vscode-descriptionForeground)', fontSize: '9px' }}>
                            Checking...
                        </span>
                    ) : initialized ? (
                        <span style={{ ...styles.statusBadge, ...styles.statusInitialized, fontSize: '9px' }}>
                            ✓ Initialized
                        </span>
                    ) : (
                        <span style={{ ...styles.statusBadge, ...styles.statusNotInitialized, fontSize: '9px' }}>
                            Not Initialized
                        </span>
                )}
                </h2>
                <div style={styles.statusPanel}>
                    {hasWorkspace === false && (
                        <p style={styles.statusNote}>
                            Open or create a project folder, then initialize RunQL.
                        </p>
                    )}
                    {hasWorkspace === true && initialized === false && (
                        <p style={styles.statusNote}>
                            Step 1 is complete. Now Initialize RunQL.
                        </p>
                    )}
                    {initialized === true && (
                        <p style={styles.statusNote}>
                            RunQL is initialized.
                        </p>
                    )}
                    {initialized !== null && (
                        <div style={styles.actionRow}>
                            <div style={styles.stepAction}>
                                <div style={styles.stepLabel}>STEP 1</div>
                                <button
                                    style={{
                                        ...styles.button,
                                        ...(step1Active ? styles.primaryButton : styles.secondaryButton),
                                        ...(step1Active ? {} : { border: '1px solid var(--vscode-textBlockQuote-background)' }),
                                        marginRight: 0
                                    }}
                                    onClick={handleOpenFolder}
                                >
                                    Open Folder
                                    <span
                                        style={{
                                            ...styles.stepCompleteIcon,
                                            ...(step1Complete ? styles.stepCompleteIconActive : styles.stepCompleteIconPending)
                                        }}
                                        aria-label={step1Complete ? 'Completed' : 'Pending'}
                                    >
                                        ✓
                                    </span>
                                </button>
                            </div>
                            <div style={styles.stepAction}>
                                <div style={styles.stepLabel}>STEP 2</div>
                                <button
                                    style={{
                                        ...styles.button,
                                        ...(step2Active ? styles.primaryButton : styles.secondaryButton),
                                        ...(step2Active ? {} : { border: '1px solid var(--vscode-panel-border)' }),
                                        marginRight: 0,
                                        ...((step2Active || step2Complete) ? {} : {
                                            opacity: 0.6,
                                            cursor: 'not-allowed'
                                        })
                                    }}
                                    onClick={handleInitialize}
                                    disabled={!hasWorkspace || initialized === true}
                                    title={
                                        initialized === true
                                            ? 'RunQL is already initialized.'
                                            : hasWorkspace
                                                ? 'Initialize RunQL'
                                                : 'Open a folder to enable initialization.'
                                    }
                                >
                                    Initialize RunQL
                                    <span
                                        style={{
                                            ...styles.stepCompleteIcon,
                                            ...(step2Complete ? styles.stepCompleteIconActive : styles.stepCompleteIconPending)
                                        }}
                                        aria-label={step2Complete ? 'Completed' : 'Pending'}
                                    >
                                        ✓
                                    </span>
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* What Initialize Creates */}
            <div style={styles.card}>
                <h2 style={styles.cardTitle}>What does Initialization do?</h2>
                <div style={{ marginTop: '10px', marginBottom: '10px' }}>
                    Creates default folders and prompt files for SQL, schema, and ERD workflows.
                </div>
                <div style={{ marginTop: '10px', marginBottom: '10px', fontSize: '13px', color: 'var(--vscode-descriptionForeground)' }}>
                    Resultset editing is enabled by default. You can disable it in RunQL Settings
                    (<code>runql.results.editing.enabled</code>).
                </div>
                <ul style={styles.folderList}>
                    {INIT_STRUCTURE.map(({ folder, files }) => (
                        <li key={folder} style={styles.folderItem}>
                            <div style={{ ...styles.folderName, ...styles.structureLabel }}>
                                <StructureIcon kind="folder" />
                                <span>{folder}</span>
                            </div>
                            {files.length > 0 ? (
                                <ul style={styles.fileList}>
                                    {files.map((file) => (
                                        <li key={`${folder}/${file}`} style={{ ...styles.fileItem, ...styles.structureLabel }}>
                                            <StructureIcon kind="file" />
                                            <span>{file}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <div style={styles.emptyFolder}>No default files at initialization</div>
                            )}
                        </li>
                    ))}
                </ul>
                <div style={{ marginTop: '10px', marginBottom: '10px' }}>
                    <div style={{ ...styles.folderName, ...styles.structureLabel }}>
                        <StructureIcon kind="file" />
                        <span>Initialization files:</span>
                    </div>
                    RunQL creates <code>AGENTS.md</code> and <code>README_RUNQL.md</code> in your project root.<br />
                    If <code>AGENTS.md</code> already exists, it creates <code>AGENTS_RUNQL.md</code> instead.
                </div>
            </div>

            {/* Documentation */}
            <div style={styles.card}>
                <h2 style={styles.cardTitle}>Documentation</h2>
                <ul style={styles.linkList}>
                    <li>
                        <a
                            style={styles.link}
                            href="https://runql.com/opensource/"
                            target="_blank"
                        >
                            RunQL Website
                        </a>
                    </li>
                    <li>
                        <a
                            style={styles.link}
                            href="https://github.com/DVCodeLabs/RunQL/blob/main/README.md"
                            target="_blank"
                        >
                            RunQL Documentation
                        </a>
                    </li>
                    <li>
                        <a
                            style={styles.link}
                            href="https://github.com/DVCodeLabs/RunQL/blob/main/docs/getting-started.md"
                            target="_blank"
                        >
                            Getting Started Guide
                        </a>
                    </li>
                    <li>
                        <a
                            style={styles.link}
                            href="https://github.com/DVCodeLabs/RunQL"
                            target="_blank"
                        >
                            Community & Support
                        </a>
                    </li>
                </ul>
            </div>

            <div id="ai-settings-guide" style={styles.card}>
                <h2 style={styles.cardTitle}>AI Settings Guide</h2>
                <p style={{ ...styles.statusNote, marginBottom: '12px' }}>
                    These are the settings that matter for AI setup in RunQL. Start with AI Source, then only fill in the settings that match that choice.
                </p>
                <div style={styles.settingsGrid}>
                    {AI_SETTINGS.map((setting) => (
                        <div key={setting.name} style={styles.settingCard}>
                            <h3 style={styles.settingName}>{setting.name}</h3>
                            <p style={styles.settingSummary}>{setting.summary}</p>
                            <p style={styles.settingDetails}>{setting.details}</p>
                        </div>
                    ))}
                </div>
                <ul style={styles.bulletList}>
                    <li>If you choose <strong>GitHub Copilot / VS Code AI</strong>, you usually only need AI Model.</li>
                    <li>If you choose <strong>AI Extension</strong>, you usually only need AI Extension.</li>
                    <li>If you choose <strong>Direct API</strong>, you usually need API Provider, AI Model, and sometimes API Base URL.</li>
                </ul>
            </div>

            {/* Quick Actions */}
            {initialized && (
                <div style={styles.card}>
                    <h2 style={styles.cardTitle}>Quick Actions</h2>
                    <div>
                        <button
                            style={{ ...styles.button, ...styles.primaryButton }}
                            onClick={handleAddConnection}
                        >
                            ➕ Add DB Connection
                        </button>
                        <button
                            style={{ ...styles.button, ...styles.secondaryButton }}
                            onClick={handleOpenSettings}
                        >
                            ⚙️ Open RunQL Settings
                        </button>
                        <button
                            style={{ ...styles.button, ...styles.secondaryButton }}
                            onClick={handleOpenReadme}
                        >
                            📘 Open README_RUNQL.md
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// Mount
const rootEl = document.getElementById('root');
if (rootEl) {
    createRoot(rootEl).render(<App />);
}
