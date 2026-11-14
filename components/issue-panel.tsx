"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import clsx from "clsx";
import { CalendarDays, CircleDot, ListChecks, PanelRightClose, Tag, UserRound, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { displayName, formatDateTime, formatDue, formatRelative } from "@/lib/format";
import { taskKey } from "@/lib/project-issues";
import { isDraftColumn } from "@/lib/origin-columns";
import { PriorityIcon, StatusIcon } from "./issue-icons";
import { AgentMark } from "./issue-agent";
import { UserAvatar } from "./user-avatar";
import { LoadingState } from "./issue-shared";
import { plainSummary } from "./issue-card";

type Task = Doc<"tasks">;
const PRIORITY: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

/** What each activity kind reads as in the panel's log ("What happened"). */
const VERB: Record<string, (row: ActivityRow) => string> = {
  delegated: row => `Delegated to ${row.to ?? "an agent"}`,
  undelegated: row => `Taken back from ${row.from ?? "the agent"}`,
  acknowledged: () => "Acknowledged the issue",
  progress: () => "Reported progress",
  question: () => "Asked a question",
  blocked: () => "Blocked",
  done: () => "Finished its part",
  commented: () => "Commented",
  status: row => `Moved from ${row.from ?? "—"} to ${row.to ?? "—"}`,
  updated: () => "Updated the issue",
  created: () => "Created the issue",
  criteria: () => "Changed acceptance criteria",
};
type ActivityRow = { id: string; kind: string; actorName: string; agentName: string | null; from: string | null; to: string | null; body: string | null; createdAt: number };

export type PanelTab = { id: Id<"tasks">; title: string };

/**
 * The issue side panel next to the board (after the agent task board reference): open issues as closable tabs, then
 * the active issue's title, summary, actions, properties and its activity log. "Open" goes to the full issue page.
 */
export function IssuePanel({ projectId, sessionToken, tabs, active, canEdit, onSelect, onCloseTab, onHide, onOpenPage, onToggleDone }: {
  projectId: Id<"projects">;
  sessionToken: string;
  tabs: PanelTab[];
  active: Id<"tasks">;
  canEdit: boolean;
  onSelect: (taskId: Id<"tasks">) => void;
  onCloseTab: (taskId: Id<"tasks">) => void;
  onHide: () => void;
  onOpenPage: (taskId: Id<"tasks">) => void;
  onToggleDone: (task: Task) => void;
}) {
  const details = useQuery(api.tasks.details, { projectId, sessionToken, taskId: active });
  const activity = useQuery(api.issueActivity.list, { sessionToken, projectId, taskId: active }) as ActivityRow[] | undefined;
  const tabList = useRef<HTMLDivElement>(null);
  useEffect(() => { tabList.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active]);

  return <aside className="issue-panel" aria-label="Issue panel" data-issue-panel={active}>
    <div className="issue-panel-tabs">
      <div ref={tabList} className="issue-panel-tablist" role="tablist" aria-label="Open issues">
        {tabs.map(tab => <div key={tab.id} className={clsx("issue-panel-tab", tab.id === active && "is-active")}>
          <button type="button" role="tab" aria-selected={tab.id === active} title={tab.title} onClick={() => onSelect(tab.id)}><CircleDot size={12} /><span>{tab.title}</span></button>
          <button type="button" className="issue-panel-tab-close" aria-label={`Close ${tab.title}`} onClick={() => onCloseTab(tab.id)}><X size={11} /></button>
        </div>)}
      </div>
      <button type="button" className="icon-button issue-panel-hide" aria-label="Hide issue panel" title="Hide panel" onClick={onHide}><PanelRightClose size={14} /></button>
    </div>
    {!details ? <div className="issue-panel-body"><LoadingState label="Opening issue" /></div> : <PanelBody details={details} activity={activity} canEdit={canEdit} onOpenPage={() => onOpenPage(active)} onToggleDone={onToggleDone} />}
  </aside>;
}

function PanelBody({ details, activity, canEdit, onOpenPage, onToggleDone }: {
  details: { task: Task; columns: Doc<"columns">[]; comments: Doc<"taskComments">[]; members: { email: string; name?: string; username?: string; avatarUrl?: string | null }[] };
  activity: ActivityRow[] | undefined;
  canEdit: boolean;
  onOpenPage: () => void;
  onToggleDone: (task: Task) => void;
}) {
  const { task, columns, members } = details;
  const column = columns.find(item => item._id === task.columnId);
  const statusLabel = task.done ? "Completed" : column?.title ?? "—";
  const statusIcon = task.done ? "Done" : column ? (isDraftColumn(column) ? "Draft" : column.title) : "Todo";
  const assignee = task.assignedToEmail ? members.find(member => member.email === task.assignedToEmail) ?? { email: task.assignedToEmail, name: task.assignedToName } : null;
  const due = formatDue(task.dueDate);
  const criteria = task.acceptanceCriteria ?? [];
  const summary = plainSummary(task.description);
  // The log: the issue's activity, newest last; the latest entry is drawn as the current one.
  const log = (activity ?? []).slice(-12);

  return <div className="issue-panel-body">
    <h2 className="issue-panel-title">{task.title}</h2>
    <p className="issue-panel-key">{taskKey(task._id)}{task.githubIssueNumber ? ` · GitHub #${task.githubIssueNumber}` : ""}</p>
    {summary ? <p className="issue-panel-summary">{summary}</p> : <p className="issue-panel-summary is-empty">No description</p>}
    <div className="issue-panel-actions">
      {canEdit && <button type="button" className={clsx("issue-panel-primary", task.done && "is-quiet")} onClick={() => onToggleDone(task)}>{task.done ? "Reopen" : "Complete"}</button>}
      <button type="button" className="issue-panel-secondary" onClick={onOpenPage}>Open</button>
    </div>

    <dl className="issue-panel-props">
      <dt>Status</dt><dd><StatusIcon title={statusIcon} /><span>{statusLabel}</span>{task.done && task.completedAt ? <small>{formatRelative(task.completedAt)}</small> : null}</dd>
      <dt>Assignee</dt><dd>{assignee ? <><UserAvatar user={assignee} size="small" /><span>{displayName(assignee)}</span></> : <><UserRound size={13} /><span className="is-muted">Unassigned</span></>}</dd>
      <dt>Agent</dt><dd>{task.delegateName ? <><AgentMark size={12} /><span>{task.delegateName}</span></> : <span className="is-muted">No agent</span>}</dd>
      <dt>Priority</dt><dd><PriorityIcon priority={task.priority} /><span>{PRIORITY[task.priority] ?? task.priority}</span></dd>
      {criteria.length > 0 && <><dt>Criteria</dt><dd><ListChecks size={13} /><span>{criteria.filter(item => item.checked).length} of {criteria.length} met</span></dd></>}
      {task.labels?.length ? <><dt>Labels</dt><dd><Tag size={13} /><span>{task.labels.join(", ")}</span></dd></> : null}
      {due && <><dt>Due</dt><dd className={clsx(!task.done && due.tone)}><CalendarDays size={13} /><span>{due.label}</span></dd></>}
    </dl>

    <section className="issue-panel-log" aria-label="Activity">
      <h3>What happened <small>{activity?.length ?? 0}</small></h3>
      {activity === undefined ? <LoadingState label="Loading activity" />
        : !log.length ? <p className="issue-panel-log-empty">Nothing yet</p>
          : <ol>{log.map((row, index) => <li key={row.id} className={clsx(index === log.length - 1 && "is-latest")}>
            <span className="issue-panel-log-dot" aria-hidden="true" />
            <span className="issue-panel-log-text">{row.agentName && row.kind !== "delegated" && row.kind !== "undelegated" ? `${row.agentName}: ` : ""}{VERB[row.kind]?.(row) ?? row.kind}</span>
            <time dateTime={new Date(row.createdAt).toISOString()} title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</time>
          </li>)}</ol>}
    </section>
  </div>;
}
