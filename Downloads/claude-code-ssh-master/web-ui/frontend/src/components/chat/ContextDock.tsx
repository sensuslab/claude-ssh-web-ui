import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  ChevronRight,
  FileText,
  Folder,
  FolderUp,
  Headphones,
  PanelRightClose,
  PanelRightOpen,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  UploadCloud,
} from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import { useChatStore } from '@/lib/store/chatStore';
import type { FileRoot, SkillItem, WorkspaceFile } from '@/lib/store/chatStore';
import { cn, formatDate } from '@/lib/utils';

type DockTab = 'files' | 'skills' | 'mcp' | 'console';

const formatSize = (size: number) => {
  if (!size) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const dockTabs: Array<{ id: DockTab; label: string; icon: React.ElementType }> = [
  { id: 'files', label: 'Files', icon: UploadCloud },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: PlugZap },
  { id: 'console', label: 'Console', icon: TerminalSquare },
];

const dataVolumeLabel = (status: ReturnType<typeof useChatStore.getState>['runtimeStatus']) => {
  if (!status?.dataVolume) return 'Checking';
  if (!status.dataVolume.exists) return 'Missing';
  if (!status.dataVolume.readable) return 'Blocked';
  return status.dataVolume.writable ? 'Writable' : 'Read only';
};

const dataVolumeTone = (status: ReturnType<typeof useChatStore.getState>['runtimeStatus']) => {
  if (!status?.dataVolume) return 'system-value-muted';
  if (!status.dataVolume.exists || !status.dataVolume.readable) return 'system-value-bad';
  return status.dataVolume.writable ? 'system-value-good' : 'system-value-warn';
};

export function ContextDock() {
  const {
    addActivity,
    addAttachment,
    addConsoleEvent,
    attachments,
    consoleEvents,
    dockOpen,
    mcpServers,
    removeAttachment,
    runtimeStatus,
    selectedFile,
    setConsoleEvents,
    setMcpServers,
    setSelectedFile,
    setSkills,
    setWorkspaceFiles,
    skills,
    toggleDock,
    workspaceFiles,
  } = useChatStore();
  const [activeTab, setActiveTab] = useState<DockTab>('files');
  const [activeRoot, setActiveRoot] = useState('workspace');
  const [fileRoots, setFileRoots] = useState<FileRoot[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [preview, setPreview] = useState<string>('');
  const [previewError, setPreviewError] = useState<string>('');
  const [mcpRaw, setMcpRaw] = useState('');
  const activeRootMeta = fileRoots.find((root) => root.id === activeRoot);

  const selectedSkillIds = useMemo(
    () => new Set(attachments.filter((item) => item.mimeType === 'application/x-skill').map((item) => item.id)),
    [attachments]
  );

  const loadAgentContext = async () => {
    try {
      const [skillData, mcpData, consoleData] = await Promise.all([
        apiClient.listSkills(),
        apiClient.listMcp(),
        apiClient.listConsoleEvents(),
      ]);
      setSkills(skillData.skills || []);
      setMcpServers(mcpData.servers || []);
      setConsoleEvents((consoleData.events || []).map((event) => ({ ...event, createdAt: new Date(event.createdAt) })));
      setMcpRaw(mcpData.raw || '');
      addActivity({ label: 'Skills, MCP, and console refreshed', tone: 'success' });
    } catch (error) {
      const label = error instanceof Error ? error.message : 'Agent context refresh failed';
      addActivity({ label, tone: 'danger' });
      addConsoleEvent({ kind: 'context', level: 'error', label });
    }
  };

  const applyFileResponse = (data: { path: string; root?: string; roots?: FileRoot[]; files: WorkspaceFile[] }) => {
    setActiveRoot(data.root || activeRoot);
    setCurrentPath(data.path);
    setWorkspaceFiles(data.files);
    if (data.roots) setFileRoots(data.roots);
  };

  useEffect(() => {
    loadAgentContext();
    apiClient
      .listFiles('', activeRoot)
      .then(applyFileResponse)
      .catch((error) => {
        addActivity({
          label: error instanceof Error ? error.message : 'File roots unavailable',
          tone: 'danger',
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = async (file: WorkspaceFile) => {
    setPreview('');
    setPreviewError('');
    const root = file.root || activeRoot;

    if (file.type === 'directory') {
      try {
        const data = await apiClient.listFiles(file.path, root);
        applyFileResponse(data);
        setSelectedFile(null);
      } catch (error) {
        addActivity({
          label: error instanceof Error ? error.message : 'Folder unavailable',
          tone: 'danger',
        });
      }
      return;
    }

    setSelectedFile(file);

    try {
      const data = await apiClient.previewFile(file.path, root);
      setPreview(data.file.content);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Preview unavailable');
    }
  };

  const openParent = async () => {
    try {
      const parent = currentPath.split('/').slice(0, -1).join('/');
      const data = await apiClient.listFiles(parent, activeRoot);
      applyFileResponse(data);
      setSelectedFile(null);
      setPreview('');
      setPreviewError('');
    } catch (error) {
      addActivity({
        label: error instanceof Error ? error.message : 'Parent folder unavailable',
        tone: 'danger',
      });
    }
  };

  const reloadFiles = async () => {
    try {
      const data = await apiClient.listFiles(currentPath, activeRoot);
      applyFileResponse(data);
      addActivity({ label: 'File list refreshed', tone: 'success' });
    } catch (error) {
      addActivity({
        label: error instanceof Error ? error.message : 'File refresh failed',
        tone: 'danger',
      });
    }
  };

  const switchRoot = async (rootId: string) => {
    try {
      setActiveRoot(rootId);
      setCurrentPath('');
      setSelectedFile(null);
      setPreview('');
      setPreviewError('');
      const data = await apiClient.listFiles('', rootId);
      applyFileResponse(data);
      addActivity({ label: `${data.roots?.find((root) => root.id === rootId)?.label || 'Files'} opened`, tone: 'success' });
    } catch (error) {
      addActivity({
        label: error instanceof Error ? error.message : 'Storage root unavailable',
        tone: 'danger',
      });
    }
  };

  const toggleSkill = (skill: SkillItem) => {
    const attachmentId = `skill:${skill.path}`;
    if (selectedSkillIds.has(attachmentId)) {
      removeAttachment(attachmentId);
      addActivity({ label: `Removed ${skill.name}`, tone: 'neutral' });
      addConsoleEvent({ kind: 'skills', level: 'info', label: `Skill detached: ${skill.name}` });
      return;
    }

    addAttachment({
      id: attachmentId,
      name: skill.name,
      path: skill.path,
      size: 0,
      mimeType: 'application/x-skill',
      description: skill.description,
      source: skill.source,
    });
    addActivity({ label: `Selected ${skill.name}`, tone: 'success' });
    addConsoleEvent({ kind: 'skills', level: 'success', label: `Skill selected: ${skill.name}` });
  };

  if (!dockOpen) {
    return (
      <button className="dock-tab" onClick={toggleDock} aria-label="Open context dock">
        <PanelRightOpen className="h-5 w-5" />
      </button>
    );
  }

  return (
    <aside className="context-dock" aria-label="Agent context dock">
      <div className="dock-heading">
        <div>
          <p>Context</p>
          <h2>Agent Space</h2>
        </div>
        <button className="icon-button" onClick={toggleDock} aria-label="Close context dock">
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <section className="glass-panel compact-panel">
        <div className="panel-title">
          <ShieldCheck className="h-4 w-4" />
          System
        </div>
        <div className="system-grid">
          <span>Claude</span>
          <strong>{runtimeStatus?.agent?.available ? 'Available' : 'Checking'}</strong>
          <span>Workspace</span>
          <strong>{runtimeStatus?.workspace?.exists ? 'Mounted' : 'Unknown'}</strong>
          <span>Data</span>
          <strong className={dataVolumeTone(runtimeStatus)}>{dataVolumeLabel(runtimeStatus)}</strong>
          <span>Safety</span>
          <strong>Confirm execute</strong>
          <span>Voice</span>
          <strong className={runtimeStatus?.features?.voice ? 'system-value-good' : 'system-value-muted'}>
            {runtimeStatus?.features?.voice ? 'Ready' : 'Disabled'}
          </strong>
        </div>
      </section>

      <div className="dock-tabbar" role="tablist" aria-label="Context views">
        {dockTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={cn(activeTab === id && 'dock-tab-active')}
            onClick={() => setActiveTab(id)}
            role="tab"
            aria-selected={activeTab === id}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {activeTab === 'files' && (
        <section className="glass-panel compact-panel">
          <div className="panel-title">
            <UploadCloud className="h-4 w-4" />
            Documents & Files
          </div>
          <div className="storage-hint">
            <span>{activeRootMeta?.label || 'Workspace'}</span>
            <strong title={activeRootMeta?.path}>{activeRootMeta?.path || currentPath || 'Project files'}</strong>
          </div>
          {fileRoots.length > 0 && (
            <div className="root-switch" role="tablist" aria-label="File root">
              {fileRoots.map((root) => (
                <button
                  key={root.id}
                  className={cn(activeRoot === root.id && 'root-switch-active')}
                  onClick={() => switchRoot(root.id)}
                  disabled={!root.exists}
                  role="tab"
                  aria-selected={activeRoot === root.id}
                  title={root.path}
                >
                  {root.label}
                </button>
              ))}
            </div>
          )}
          <div className="file-toolbar">
            <span>{currentPath || fileRoots.find((root) => root.id === activeRoot)?.label || 'workspace'}</span>
            <div className="flex items-center gap-1">
              <button
                className="mini-icon-button"
                onClick={openParent}
                disabled={!currentPath}
                aria-label="Open parent folder"
                title="Parent folder"
              >
                <FolderUp className="h-3.5 w-3.5" />
              </button>
              <button
                className="mini-icon-button"
                onClick={reloadFiles}
                aria-label="Refresh files"
                title="Refresh files"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="file-list">
            {workspaceFiles.length === 0 ? (
              <p className="panel-empty">No workspace files visible yet.</p>
            ) : (
              workspaceFiles.slice(0, 10).map((file) => {
                const Icon = file.type === 'directory' ? Folder : FileText;
                return (
                  <button
                    key={file.path || file.name}
                    className={cn('file-row', selectedFile?.path === file.path && 'file-row-active')}
                    onClick={() => openFile(file)}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate text-left">{file.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {file.type === 'directory' ? 'Folder' : formatSize(file.size)}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                );
              })
            )}
          </div>
          {selectedFile && selectedFile.type === 'file' && (
            <div className="file-preview">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="truncate text-xs font-medium">{selectedFile.name}</span>
                <span className="text-[11px] text-muted-foreground">{formatSize(selectedFile.size)}</span>
              </div>
              {previewError ? (
                <p className="text-xs text-amber-200">{previewError}</p>
              ) : (
                <pre>{preview || 'Loading preview...'}</pre>
              )}
            </div>
          )}
        </section>
      )}

      {activeTab === 'skills' && (
        <section className="glass-panel compact-panel">
          <div className="panel-title panel-title-split">
            <span>
              <Sparkles className="h-4 w-4" />
              Skills
            </span>
            <button className="mini-icon-button" onClick={loadAgentContext} aria-label="Refresh skills">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="skill-list">
            {skills.length === 0 ? (
              <p className="panel-empty">No skills found in the configured roots.</p>
            ) : (
              skills.map((skill) => {
                const selected = selectedSkillIds.has(`skill:${skill.path}`);
                return (
                  <button
                    key={skill.id}
                    className={cn('skill-row', selected && 'skill-row-selected')}
                    onClick={() => toggleSkill(skill)}
                  >
                    <span className="skill-row-main">
                      <strong>{skill.name}</strong>
                      <small>{skill.description || skill.directory}</small>
                    </span>
                    <span className="skill-select-mark">
                      {selected ? <Check className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>
      )}

      {activeTab === 'mcp' && (
        <section className="glass-panel compact-panel">
          <div className="panel-title panel-title-split">
            <span>
              <PlugZap className="h-4 w-4" />
              Active MCP
            </span>
            <button className="mini-icon-button" onClick={loadAgentContext} aria-label="Refresh MCP">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mcp-list">
            {mcpServers.length === 0 ? (
              <p className="panel-empty">No MCP servers reported by the CLI.</p>
            ) : (
              mcpServers.map((server) => (
                <div key={`${server.source}-${server.name}`} className="mcp-row">
                  <span className="state-dot" />
                  <div>
                    <strong>{server.name}</strong>
                    <small>{server.command || server.source || server.status}</small>
                  </div>
                  <em>{server.status}</em>
                </div>
              ))
            )}
          </div>
          {mcpRaw && <pre className="raw-console">{mcpRaw}</pre>}
        </section>
      )}

      {activeTab === 'console' && (
        <section className="glass-panel compact-panel">
          <div className="panel-title panel-title-split">
            <span>
              <TerminalSquare className="h-4 w-4" />
              Agent Console
            </span>
            <button className="mini-icon-button" onClick={loadAgentContext} aria-label="Refresh console">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="console-feed">
            {consoleEvents.length === 0 ? (
              <p className="panel-empty">No console events yet.</p>
            ) : (
              consoleEvents.map((event) => (
                <div key={event.id} className={cn('console-row', `console-${event.level}`)}>
                  <span>{event.kind}</span>
                  <p>{event.label}</p>
                  {event.detail && <pre>{event.detail}</pre>}
                  <time>{formatDate(event.createdAt)}</time>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      <section className="glass-panel compact-panel activity-panel">
        <div className="panel-title">
          <Activity className="h-4 w-4" />
          Agent Activity
        </div>
        <div className="activity-list">
          {consoleEvents.length === 0 ? (
            <p className="panel-empty">Activity appears here as the agent works.</p>
          ) : (
            consoleEvents.slice(0, 4).map((item) => {
              const tone = item.level === 'error' ? 'danger' : item.level === 'info' ? 'neutral' : item.level;
              return (
                <div key={item.id} className={cn('activity-row', `activity-${tone}`)}>
                  <span />
                  <div>
                    <p>{item.label}</p>
                    <time>{formatDate(item.createdAt)}</time>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="glass-panel compact-panel voice-panel">
        <div className="panel-title">
          <Headphones className="h-4 w-4" />
          Voice & Settings
        </div>
        <div className="system-grid">
          <span>Voice</span>
          <strong className={runtimeStatus?.features?.voice ? 'system-value-good' : 'system-value-muted'}>
            {runtimeStatus?.features?.voice ? 'Ready' : 'Disabled'}
          </strong>
          <span>Data</span>
          <strong className={dataVolumeTone(runtimeStatus)}>{dataVolumeLabel(runtimeStatus)}</strong>
          <span>Motion</span>
          <strong>Adaptive</strong>
        </div>
      </section>
    </aside>
  );
}
