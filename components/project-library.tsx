"use client";
import { formatBytes } from "@/lib/format-bytes";
import { errorText } from "@/lib/error-text";
import { formatDate } from "@/lib/format";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import clsx from "clsx";
import { Check, Copy, Eye, EyeOff, File, FileText, ImageIcon, KeyRound, KeySquare, LayoutGrid, Link2, List, Loader2, Pencil, PenTool, Plus, Search, Shapes, Shuffle, Smartphone, SquareAsterisk, StickyNote, Trash2, Type, Upload, X, type LucideIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { decryptSecret, type EncryptedSecret } from "@/lib/vaultCrypto";
import type { FunctionReturnType } from "convex/server";
import { Dialog } from "./dialog";
import { RECONNECT_TO_CREATE, useWorkspaceOnline } from "./workspace-connection";
import { useFileDrop } from "./use-file-drop";
import { validateAttachmentFiles } from "@/lib/dropped-content";
import { assetFileType, saveAssetFiles } from "@/lib/asset-uploads";
import { linkAssetName, linkAssetType } from "@/lib/asset-links";
import { DelayedSkeleton } from "./delayed-skeleton";
import { DeleteDialog } from "./confirm-button";

type Props = { projectId: Id<"projects">; sessionToken: string };

/** Search field used by the Assets and Vault toolbars. */
function LibrarySearch({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="library-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && value) { event.stopPropagation(); onChange(""); } }} /></label>;
}

export { ProjectEmpty } from "./project-empty";
import { ProjectEmpty } from "./project-empty";

/* ---------------------------------------------------------------- vault */

const kinds = { password: "Login", api_key: "API key", secret: "Secret", note: "Secure note" };
const kindIcons: Record<string, LucideIcon> = { password: KeyRound, api_key: KeySquare, secret: SquareAsterisk, note: StickyNote };
type Kind = keyof typeof kinds;
type VaultItem = FunctionReturnType<typeof api.credentials.list>[number];

function hostOf(url?: string) {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/**
 * The project's Vault. Values are sealed by the server, so it opens directly: members reveal and copy, editors add,
 * edit and delete. Items from before (encrypted with the old Vault password) are listed with a "Needs conversion"
 * marker until someone converts them once with that password (VaultConversion).
 */
export function VaultPanel({ projectId, sessionToken, canEdit }: Props & { canEdit: boolean }) {
  const online = useWorkspaceOnline();
  const items = useQuery(api.credentials.list, { projectId, sessionToken });
  const remove = useMutation(api.credentials.remove);
  const revealValue = useMutation(api.credentials.reveal);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<VaultItem | "new" | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<VaultItem | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  // A changed item shows its new value on the next reveal, not a stale one.
  const hide = (id: string) => setRevealed(current => { const next = { ...current }; delete next[id]; return next; });
  const reveal = async (item: VaultItem, copy = false) => {
    setNotice("");
    try {
      if (!copy && revealed[item._id] !== undefined) { hide(item._id); return; }
      const value = revealed[item._id] ?? await revealValue({ projectId, sessionToken, credentialId: item._id });
      if (copy) {
        await navigator.clipboard.writeText(value);
        setCopied(item._id);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
      } else setRevealed(current => ({ ...current, [item._id]: value }));
    } catch (error) { setNotice(copy && error instanceof DOMException && error.name === "NotAllowedError" ? "Copy was blocked by the browser" : errorText(error, "Could not open this item")); }
  };

  if (items === undefined) return <DelayedSkeleton label="Loading vault" />;
  const filtered = items.filter(item => `${item.title} ${item.username || ""} ${item.url || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const legacyCount = items.filter(item => item.needsConversion).length;
  return <section className="project-library" aria-label="Vault">
    <div className="library-toolbar">
      {items.length > 0 ? <LibrarySearch label="Search vault" value={query} onChange={setQuery} /> : <span className="library-toolbar-spacer" />}
      {canEdit && items.length > 0 && <button className="primary-button compact" disabled={!online} title={!online ? RECONNECT_TO_CREATE : undefined} aria-label="New item" onClick={() => setEditing("new")}><Plus size={14} /><span className="library-button-label">New item</span></button>}
    </div>
    <VaultConversion projectId={projectId} sessionToken={sessionToken} canEdit={canEdit} legacyCount={legacyCount} online={online} />
    {notice && <p className="notice danger" role="alert">{notice}<button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice("")}><X size={14} /></button></p>}
    {!items.length ? <ProjectEmpty icon={KeyRound} title="No secrets">{canEdit && <button className="primary-button compact" disabled={!online} title={!online ? RECONNECT_TO_CREATE : undefined} onClick={() => setEditing("new")}><Plus size={14} />New item</button>}</ProjectEmpty>
      : !filtered.length ? <ProjectEmpty icon={Search} title="No matching items" />
        : <ul className="vault-list">{filtered.map(item => {
          const Icon = kindIcons[item.kind || ""] || KeyRound;
          const secret = revealed[item._id];
          const host = hostOf(item.url);
          const locked = item.needsConversion;
          return <li className={clsx("vault-row", secret !== undefined && "revealed")} key={item._id}>
            <span className="library-file-icon"><Icon size={15} /></span>
            <div className="vault-row-main">
              <strong>{item.title}</strong>
              <span className="vault-row-meta"><span>{kinds[item.kind as Kind] || "Secret"}</span>{locked && <span className="vault-needs-conversion" title="Encrypted with the old Vault password. Convert old items once to read it.">Needs conversion</span>}{item.username && <span>{item.username}</span>}{host && <a href={item.url} target="_blank" rel="noreferrer noopener">{host}</a>}</span>
              {secret !== undefined && <code className="secret-code">{secret}</code>}
            </div>
            <div className="library-row-actions">
              {!locked && <button className="icon-button" aria-label={secret !== undefined ? `Hide ${item.title}` : `Reveal ${item.title}`} title={secret !== undefined ? "Hide" : "Reveal"} aria-pressed={secret !== undefined} onClick={() => reveal(item)}>{secret !== undefined ? <EyeOff size={15} /> : <Eye size={15} />}</button>}
              {!locked && <button className={clsx("icon-button", copied === item._id && "copied")} aria-label={copied === item._id ? "Copied" : `Copy ${item.title}`} title="Copy" onClick={() => reveal(item, true)}>{copied === item._id ? <Check size={15} /> : <Copy size={15} />}</button>}
              {canEdit && <button type="button" className="icon-button" aria-label={`Edit ${item.title}`} title="Edit" disabled={!online} onClick={() => setEditing(item)}><Pencil size={15} /></button>}
              {canEdit && <button type="button" className="icon-button" aria-label={`Delete ${item.title}`} title="Delete" onClick={() => setDeleting(item)}><Trash2 size={15} /></button>}
            </div>
          </li>;
        })}</ul>}
    {editing && <VaultItemDialog projectId={projectId} sessionToken={sessionToken} online={online} item={editing === "new" ? null : editing} onSaved={id => hide(id)} onClose={() => setEditing(null)} />}
    {deleting && <DeleteDialog title="Delete vault item" subject={deleting.title} icon={(() => { const Icon = kindIcons[deleting.kind || ""] || KeyRound; return <Icon size={15} />; })()} onCancel={() => setDeleting(null)} onConfirm={async () => {
      await remove({ projectId, sessionToken, credentialId: deleting._id });
      hide(deleting._id);
      setDeleting(null);
    }} />}
  </section>;
}

/**
 * The one-time conversion of items from before the Vault was sealed by the server. The old password opens them in this
 * browser (lib/vaultCrypto.ts); each value is then sealed by the server and its password-encrypted copy dropped. It also
 * converts the person's own legacy personal items that open with the same password. Never asked again afterwards.
 */
function VaultConversion({ projectId, sessionToken, canEdit, legacyCount, online }: Props & { canEdit: boolean; legacyCount: number; online: boolean }) {
  const projectLegacy = useQuery(api.credentials.legacyItems, legacyCount && canEdit ? { projectId, sessionToken } : "skip");
  const personalLegacy = useQuery(api.personalCredentials.legacyItems, { sessionToken });
  const convertProject = useMutation(api.credentials.convertLegacy);
  const convertPersonal = useMutation(api.personalCredentials.convertLegacy);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const project = projectLegacy ?? [];
  const personal = personalLegacy ?? [];
  if (!legacyCount && !personal.length) return done ? <p className="notice success" role="status">{done}</p> : null;
  if (!canEdit && !personal.length) return <p className="notice vault-conversion" role="status">{legacyCount === 1 ? "1 old item needs" : `${legacyCount} old items need`} a one-time conversion. A project editor who knows the old Vault password converts them in this Vault.</p>;

  const convert = async (event: FormEvent) => {
    event.preventDefault(); if (!online || !password) return;
    setBusy(true); setError(""); setDone("");
    try {
      const open = async (rows: Array<EncryptedSecret & { id: string }>) => (await Promise.all(rows.map(async row => {
        try { return { id: row.id, secret: await decryptSecret(row, password) }; } catch { return null; }
      }))).filter(row => row !== null);
      const [projectOpened, personalOpened] = await Promise.all([open(project), open(personal)]);
      const total = project.length + personal.length;
      const opened = projectOpened.length + personalOpened.length;
      if (!opened) { setError("Wrong password: no old item opened with it."); return; }
      if (projectOpened.length) await convertProject({ projectId, sessionToken, items: projectOpened.map(row => ({ credentialId: row.id as Id<"credentials">, secret: row.secret })) });
      if (personalOpened.length) await convertPersonal({ sessionToken, items: personalOpened.map(row => ({ itemId: row.id as Id<"personalCredentials">, secret: row.secret })) });
      setPassword("");
      if (opened < total) setError(`${opened} of ${total} old items converted. The rest did not open with this password; enter the password they were saved with.`);
      else setDone(opened === 1 ? "1 old item converted. The Vault no longer needs a password." : `${opened} old items converted. The Vault no longer needs a password.`);
    } catch (failure) { setError(errorText(failure, "Could not convert the old items")); }
    finally { setBusy(false); }
  };
  const count = (canEdit ? legacyCount : 0) + personal.length;
  return <form className="notice vault-conversion" onSubmit={convert} aria-label="Convert old items">
    <span><strong>Convert old items: enter the old Vault password once.</strong> {count === 1 ? "1 item was" : `${count} items were`} saved with the old Vault password. After converting, the Vault never asks for a password again.</span>
    <span className="vault-conversion-row">
      <input type="password" aria-label="Old Vault password" placeholder="Old Vault password" autoComplete="off" value={password} onChange={event => { setPassword(event.target.value); setError(""); }} required aria-invalid={Boolean(error) || undefined} aria-describedby={error ? "vault-conversion-error" : undefined} />
      <button className="primary-button compact" title={!online ? RECONNECT_TO_CREATE : undefined} disabled={busy || !password || !online || (canEdit && legacyCount > 0 && projectLegacy === undefined) || personalLegacy === undefined}>{busy && <Loader2 className="spin" size={15} />}Convert</button>
    </span>
    {error && <span id="vault-conversion-error" role="alert" className="field-error">{error}</span>}
  </form>;
}

function VaultItemDialog({ projectId, sessionToken, online, item, onSaved, onClose }: Props & { online: boolean; item: VaultItem | null; onSaved: (id: Id<"credentials">) => void; onClose: () => void }) {
  const create = useMutation(api.credentials.create);
  const update = useMutation(api.credentials.update);
  const editableKind = !item || !item.kind || item.kind in kinds;
  const [kind, setKind] = useState<Kind>(item?.kind && item.kind in kinds ? item.kind as Kind : "password");
  const [title, setTitle] = useState(item?.title ?? "");
  const [username, setUsername] = useState(item?.username ?? "");
  const [url, setUrl] = useState(item?.url ?? "");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Editing keeps the value unless a new one is typed; a legacy item needs a value only if it is to become readable now.
  const secretRequired = !item;
  const generate = () => { const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_"; setSecret(Array.from(crypto.getRandomValues(new Uint8Array(32))).map(n => alphabet[n % alphabet.length]).join("")); setShow(true); };
  const save = async (e: FormEvent) => {
    e.preventDefault(); if (!online) return; setBusy(true); setError("");
    try {
      const login = kind === "password";
      if (item) {
        const fields = editableKind ? { kind, username: login ? username : "", url: login ? url : "" } : {};
        await update({ projectId, sessionToken, credentialId: item._id, ...fields, title, ...(secret ? { secret } : {}) });
        onSaved(item._id);
      } else await create({ projectId, sessionToken, kind, title, username: login && username ? username : undefined, url: login && url ? url : undefined, secret });
      onClose();
    } catch (error) { setError(errorText(error, "Could not save")); }
    finally { setBusy(false); }
  };
  const secretLabel = !editableKind ? "Value" : kind === "note" ? "Note" : kind === "password" ? "Password" : kind === "api_key" ? "Key" : "Secret";
  const keepHint = item ? (item.needsConversion ? "Leave empty to keep the old value (it still needs conversion)" : "Leave empty to keep the current value") : undefined;
  return <Dialog title={item ? "Edit vault item" : "New vault item"} onClose={onClose}><form className="stack-form library-form" onSubmit={save}>
    {editableKind && <div className="segmented-control library-kind" role="radiogroup" aria-label="Type">{(Object.keys(kinds) as Kind[]).map(value => <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>{kinds[value]}</button>)}</div>}
    <label>Name<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={150} /></label>
    {kind === "password" && editableKind && <div className="library-form-pair">
      <label>Username<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></label>
      <label>Website<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" /></label>
    </div>}
    {kind === "note" || !editableKind
      ? <label>{secretLabel}<textarea value={secret} onChange={e => setSecret(e.target.value)} required={secretRequired} placeholder={keepHint} rows={5} spellCheck={false} /></label>
      : <label>{secretLabel}<span className="secret-input">
        <input type={show ? "text" : "password"} value={secret} onChange={e => setSecret(e.target.value)} required={secretRequired} placeholder={keepHint} autoComplete="new-password" spellCheck={false} />
        <button type="button" className="icon-button" aria-label={show ? "Hide" : "Show"} aria-pressed={show} onClick={() => setShow(value => !value)}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
        {kind === "password" && <button type="button" className="icon-button" aria-label="Generate password" title="Generate password" onClick={generate}><Shuffle size={15} /></button>}
      </span></label>}
    {error && <p className="notice danger" role="alert">{error}</p>}
    <div className="library-form-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" title={!online ? RECONNECT_TO_CREATE : undefined} disabled={busy || !online}>{busy && <Loader2 className="spin" size={15} />}Save</button></div>
  </form></Dialog>;
}

/* --------------------------------------------------------------- assets */

type AssetType = Doc<"designAssets">["type"];
type Asset = Doc<"designAssets"> & { fileUrl: string | null | undefined };
const assetTypes: Array<{ value: AssetType; label: string; plural: string; icon: LucideIcon }> = [
  { value: "image", label: "Image", plural: "Images", icon: ImageIcon },
  { value: "document", label: "Document", plural: "Documents", icon: FileText },
  { value: "figma", label: "Figma", plural: "Figma", icon: PenTool },
  { value: "icon", label: "Icon", plural: "Icons", icon: Shapes },
  { value: "font", label: "Font", plural: "Fonts", icon: Type },
  { value: "apk", label: "APK", plural: "APKs", icon: Smartphone },
  { value: "other", label: "Other", plural: "Other", icon: File },
];
const typeInfo = (type: string) => assetTypes.find(item => item.value === type) || assetTypes[assetTypes.length - 1];
const VIEW_KEY = "origin.assets.view";

/** Only uploaded files preview: a link's image lives on another origin, which the CSP keeps out. */
function isPreviewable(asset: Asset) {
  if (!asset.fileUrl || !asset.storageId) return false;
  if (asset.contentType) return asset.contentType.startsWith("image/");
  return asset.type === "image" || asset.type === "icon";
}
/** Host for links, extension and size for files; `fallback` when that would only repeat the name. */
function assetMeta(asset: Asset, fallback: string) {
  if (!asset.storageId) {
    const host = hostOf(asset.url);
    return host && host !== asset.name ? host : fallback;
  }
  const extension = asset.name.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toUpperCase() || asset.contentType?.split("/")[1]?.split(/[+.;]/)[0]?.toUpperCase() || typeInfo(asset.type).label;
  return asset.size ? `${extension} · ${formatBytes(asset.size)}` : extension;
}

function AssetThumb({ asset, size }: { asset: Asset; size: "card" | "row" }) {
  const [failed, setFailed] = useState(false);
  const Icon = asset.storageId ? typeInfo(asset.type).icon : asset.type === "figma" ? PenTool : Link2;
  if (isPreviewable(asset) && !failed) return <img className={clsx("asset-image", asset.type === "icon" && "contain")} src={asset.fileUrl!} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
  return <span className="asset-type-icon"><Icon size={size === "card" ? 26 : 15} strokeWidth={size === "card" ? 1.5 : 2} /></span>;
}

export function AssetsPanel({ projectId, sessionToken, canEdit }: Props & { canEdit: boolean }) {
  const online = useWorkspaceOnline();
  const design = useQuery(api.design.list, { projectId, sessionToken });
  const remove = useMutation(api.design.removeAsset);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | AssetType>("all");
  const [view, setView] = useState<"grid" | "list">(() => { try { return typeof window !== "undefined" && window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; } });
  const [dialog, setDialog] = useState<{ files: File[]; url: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<Asset | null>(null);
  const chooseView = (next: "grid" | "list") => { setView(next); try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* Per-browser preference only. */ } };
  const selectFiles = (selection: File[]) => {
    if (!selection.length) return;
    try { validateAttachmentFiles(selection); setNotice(""); setDialog({ files: selection, url: "" }); }
    catch (error) { setNotice(errorText(error, "Invalid file")); }
  };
  const drop = useFileDrop({ disabled: !online || !canEdit || Boolean(dialog), onFiles: selectFiles, onLink: url => setDialog({ files: [], url }) });
  const assets = design?.assets as Asset[] | undefined;
  const presentTypes = assetTypes.filter(type => assets?.some(asset => asset.type === type.value));
  const activeFilter = filter !== "all" && presentTypes.some(type => type.value === filter) ? filter : "all";
  const needle = query.trim().toLowerCase();
  const filtered = assets?.filter(asset => (activeFilter === "all" || asset.type === activeFilter) && `${asset.name} ${asset.notes || ""}`.toLowerCase().includes(needle));
  // One "Add asset" action (file or link) in the toolbar and the empty state; on phones the toolbar shows only its icon.
  const addButton = (inToolbar: boolean) => canEdit && <button className="primary-button compact" disabled={!online} title={!online ? RECONNECT_TO_CREATE : undefined} aria-label={inToolbar ? "Add asset" : undefined} onClick={() => setDialog({ files: [], url: "" })}><Plus size={14} />{inToolbar ? <span className="library-button-label">Add asset</span> : "Add asset"}</button>;
  const deleteButton = (asset: Asset, className: string) => canEdit && <button type="button" className={className} aria-label={`Delete ${asset.name}`} title="Delete" onClick={() => setDeleting(asset)}><Trash2 size={14} /></button>;

  return <section aria-label="Assets" className={clsx("project-library project-assets", drop.dragging && "drop-active")} {...drop.handlers}>
    {assets?.length ? <div className="library-toolbar">
      <LibrarySearch label="Search assets" value={query} onChange={setQuery} />
      {presentTypes.length > 1 && <select className="library-filter" aria-label="Type" value={activeFilter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="all">All types</option>{presentTypes.map(type => <option key={type.value} value={type.value}>{type.plural}</option>)}</select>}
      <div className="segmented-control library-view" role="group" aria-label="View">
        <button type="button" aria-label="Grid" aria-pressed={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => chooseView("grid")}><LayoutGrid size={14} /></button>
        <button type="button" aria-label="List" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => chooseView("list")}><List size={14} /></button>
      </div>
      {addButton(true)}
    </div> : null}
    {notice && <p className="notice danger" role="alert">{notice}<button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice("")}><X size={14} /></button></p>}
    {assets === undefined ? <DelayedSkeleton label="Loading assets" />
      : !assets.length ? <ProjectEmpty icon={ImageIcon} title="No assets">{addButton(false)}</ProjectEmpty>
        : !filtered?.length ? <ProjectEmpty icon={Search} title="No matching assets" />
          : view === "grid" ? <ul className="asset-grid">{filtered.map(asset => <li className="asset-card" key={asset._id}>
            <a className="asset-thumb" href={asset.fileUrl || undefined} target="_blank" rel="noreferrer noopener" aria-label={`Open ${asset.name}`}><AssetThumb asset={asset} size="card" /></a>
            <div className="asset-info"><strong title={asset.name}>{asset.name}</strong><small>{assetMeta(asset, typeInfo(asset.type).label)}</small>{asset.notes && <small className="asset-notes" title={asset.notes}>{asset.notes}</small>}</div>
            {deleteButton(asset, "asset-delete")}
          </li>)}</ul>
            : <ul className="asset-list">{filtered.map(asset => <li className="asset-row" key={asset._id}>
              <a className="asset-row-link" href={asset.fileUrl || undefined} target="_blank" rel="noreferrer noopener">
                <span className="asset-row-thumb"><AssetThumb asset={asset} size="row" /></span>
                <span className="asset-row-name"><strong>{asset.name}</strong>{asset.notes && <small>{asset.notes}</small>}</span>
                <span className="asset-row-type">{typeInfo(asset.type).label}</span>
                <span className="asset-row-meta">{assetMeta(asset, "")}</span>
                <time className="asset-row-date" dateTime={new Date(asset.updatedAt).toISOString()}>{formatDate(asset.updatedAt)}</time>
              </a>
              {deleteButton(asset, "icon-button")}
            </li>)}</ul>}
    {drop.dragging && <div className="library-drop-overlay" aria-hidden="true"><Upload size={20} /><span>Drop to upload</span></div>}
    {dialog && <AssetDialog key={`${dialog.files.length}:${dialog.url}`} projectId={projectId} sessionToken={sessionToken} online={online} initialFiles={dialog.files} initialUrl={dialog.url} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setQuery(""); setFilter("all"); }} />}
    {deleting && <DeleteDialog title="Delete asset" subject={deleting.name} icon={<span className="confirm-subject-thumb"><AssetThumb asset={deleting} size="row" /></span>} onCancel={() => setDeleting(null)} onConfirm={async () => { await remove({ projectId, sessionToken, assetId: deleting._id }); setDeleting(null); }} />}
  </section>;
}

function AssetDialog({ projectId, sessionToken, online, initialFiles, initialUrl, onClose, onSaved }: Props & { online: boolean; initialFiles: File[]; initialUrl: string; onClose: () => void; onSaved: () => void }) {
  const upload = useMutation(api.design.generateUploadUrl);
  const create = useMutation(api.design.createAsset);
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [name, setName] = useState(initialFiles[0]?.name.slice(0, 150) || linkAssetName(initialUrl));
  const [url, setUrl] = useState(initialUrl);
  const [notes, setNotes] = useState("");
  const [type, setType] = useState<AssetType>(initialFiles[0] ? assetFileType(initialFiles[0]) : linkAssetType(initialUrl));
  // Name and type follow the chosen file or the typed link until the user changes them.
  const edited = useRef({ name: false, type: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const uploaded = useRef(new Map<File, Id<"_storage">>());
  const inFlight = useRef(false);
  // The latest list, for removals that run inside the async upload loop.
  const filesRef = useRef(files);
  /** Removes a file; when one is left, unedited name and type follow it, as if it had been picked alone. */
  const removeFile = (file: File) => {
    uploaded.current.delete(file);
    const next = filesRef.current.filter(item => item !== file);
    filesRef.current = next;
    setFiles(next);
    if (next.length === 1) {
      if (!edited.current.name) setName(next[0].name.slice(0, 150));
      if (!edited.current.type) setType(assetFileType(next[0]));
    } else if (!next.length) {
      edited.current = { name: false, type: false };
      setName(""); setType("other");
    }
  };
  const setLink = (link: string) => {
    setUrl(link);
    if (!edited.current.name) setName(linkAssetName(link));
    if (!edited.current.type) setType(linkAssetType(link));
  };
  const drop = useFileDrop({ disabled: busy, onFiles: selection => choose(selection), onLink: link => { uploaded.current.clear(); filesRef.current = []; setFiles([]); edited.current = { name: false, type: false }; setLink(link); } });
  const batch = files.length > 1;
  const choose = (selection: File[]) => {
    if (inFlight.current || !selection.length) return;
    try {
      validateAttachmentFiles(selection);
      uploaded.current.clear(); setError(""); filesRef.current = selection; setFiles(selection); setUrl("");
      edited.current = { name: false, type: false };
      setName(selection[0].name.slice(0, 150)); setType(assetFileType(selection[0]));
    } catch (error) { setError(errorText(error, "Invalid file")); }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault(); if (!online || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      if (!files.length && !url) throw new Error("Choose a file or enter a link");
      if (files.length) {
        await saveAssetFiles({ files, uploaded: uploaded.current,
          upload: async file => {
            const response = await fetch(await upload({ projectId, sessionToken }), { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
            if (!response.ok) throw new Error(`${file.name}: upload failed`);
            return (await response.json()).storageId as Id<"_storage">;
          },
          save: async (file, storageId) => { await create({ projectId, sessionToken, type: batch ? assetFileType(file) : type, name: batch ? file.name.slice(0, 150) : name, storageId, notes: notes || undefined, contentType: file.type || undefined, size: file.size }); },
          onSaved: removeFile,
          onProgress: (current, total) => setProgress(`Uploading ${current} of ${total}`),
        });
      } else await create({ projectId, sessionToken, type, name, url: url || undefined, notes: notes || undefined });
      onSaved();
    } catch (error) { setError(errorText(error, "Could not save asset")); }
    finally { inFlight.current = false; setBusy(false); setProgress(""); }
  };
  return <Dialog title={batch ? `Upload ${files.length} files` : "Add asset"} onClose={() => { if (!inFlight.current) onClose(); }}><form className="stack-form library-form" onSubmit={save}>
    <fieldset className="asset-upload-fields" disabled={busy}>
      {files.length ? <ul className="asset-upload-list">{files.map((file, index) => <li key={`${file.name}:${index}`}><File size={15} /><span title={file.name}>{file.name}</span><small>{formatBytes(file.size)}</small><button type="button" className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(file)}><X size={14} /></button></li>)}</ul>
        : <button type="button" className={clsx("asset-drop", drop.dragging && "drop-active")} onClick={() => fileInput.current?.click()} {...drop.handlers}><Upload size={20} /><span>Choose files or drop them here</span></button>}
      <input ref={fileInput} aria-label="Asset files" type="file" multiple hidden onChange={e => { choose(Array.from(e.target.files || [])); e.target.value = ""; }} />
      {!files.length && <label>Or a link<input type="url" value={url} onChange={e => setLink(e.target.value)} placeholder="https://" /></label>}
      {!batch && (files.length > 0 || url) && <div className="library-form-pair">
        <label>Name<input value={name} onChange={e => { edited.current.name = Boolean(e.target.value); setName(e.target.value); }} required maxLength={150} /></label>
        <label>Type<select value={type} onChange={e => { edited.current.type = true; setType(e.target.value as AssetType); }}>{assetTypes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      </div>}
      {(files.length > 0 || url) && <label>Notes<textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} /></label>}
    </fieldset>
    {error && <p className="notice danger" role="alert">{error}</p>}
    <div className="library-form-actions">
      {busy && <span className="asset-upload-progress" role="status">{progress || "Saving"}</span>}
      <button type="button" className="ghost-button" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="primary-button" title={!online ? RECONNECT_TO_CREATE : undefined} disabled={!online || busy || (!files.length && !url)}>{busy && <Loader2 className="spin" size={15} />}{files.length > 1 ? `Upload ${files.length}` : files.length ? "Upload" : "Add"}</button>
    </div>
  </form></Dialog>;
}
