"use client";

import { useEffect } from "react";
import { canAnimateTaskExit, selectionBox } from "@/lib/workspace-motion";

/*
 * Motion layer for the workspace. It observes the DOM that React renders and adds
 * choreography on top: FLIP moves for issue cards and projects, exit ghosts for
 * completed issues, sliding selection highlights, and counter bumps.
 * Nothing here owns state, so removing this component only removes motion.
 */

/** Where a tracked element was, and what kind it was (a card and a list row of the same issue never FLIP into each other). */
type Box = { x: number; y: number; w: number; h: number; kind?: string };

const TRACKED = "[data-task-id], [data-project-id]";
const BUMPS = ".kanban-tools > span, .nav-item small, .project-issue-count, .segmented-control button > span, .board-progress strong";
const SPRING = "cubic-bezier(.2, .9, .25, 1.05)";
const OUT = "cubic-bezier(.16, 1, .3, 1)";

function keyOf(element: HTMLElement) {
  if (element.dataset.taskId) return `t:${element.dataset.taskId}`;
  if (element.dataset.projectId) return `p:${element.dataset.projectId}`;
  return null;
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height, kind: element.tagName };
}

export function MotionLayer() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".workspace-app");
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cache = new Map<string, Box>();
    const completing = new Map<string, number>();
    const overlay = document.createElement("div");
    overlay.className = "motion-overlay";
    overlay.setAttribute("aria-hidden", "true");
    root.appendChild(overlay);
    root.dataset.motion = "on";

    const moving = (element: HTMLElement) => element.getAnimations().some(animation => animation.playState === "running" && (animation as CSSAnimation).animationName === undefined);

    const snapshot = () => {
      root.querySelectorAll<HTMLElement>(TRACKED).forEach(element => {
        const key = keyOf(element);
        if (!key || moving(element)) return;
        const box = boxOf(element);
        if (box.w) cache.set(key, box);
      });
    };

    /* ------------------------------------------------------------ gliders */
    const glide = (container: Element | null, activeSelector: string, gliderSelector: string) => {
      if (!container) return;
      const glider = container.querySelector<HTMLElement>(gliderSelector);
      if (!glider) return;
      const active = container.querySelector<HTMLElement>(activeSelector);
      const hide = () => { glider.style.opacity = "0"; glider.dataset.visible = "false"; };
      if (!active || !active.offsetParent) return hide();
      const rect = active.getBoundingClientRect();
      const box = selectionBox(active, container as HTMLElement);
      const clip = active.parentElement?.closest(".sidebar-project-list")?.getBoundingClientRect();
      const top = container.getBoundingClientRect().top + box.y - container.scrollTop;
      if (clip && (top < clip.top - 1 || top + box.height > clip.bottom + 1)) return hide();
      const first = !glider.dataset.ready;
      const avatar = glider.querySelector<HTMLElement>(".nav-glider-avatar");
      if (avatar) {
        const shown = active.querySelector<HTMLElement>("[data-self-viewer]");
        const source = shown?.offsetParent ? shown : null;
        avatar.style.display = source ? "grid" : "none";
        if (source) {
          const position = source.getBoundingClientRect();
          Object.assign(avatar.style, { left: `${position.left - rect.left}px`, top: `${position.top - rect.top}px`, width: `${position.width}px`, height: `${position.height}px` });
        }
      }
      glider.style.transition = first || reduced.matches ? "none" : "";
      glider.style.opacity = "1";
      glider.style.width = `${box.width}px`;
      glider.style.height = `${box.height}px`;
      glider.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
      glider.dataset.ready = "true";
      glider.dataset.visible = "true";
    };
    const updateGliders = () => {
      glide(root.querySelector(".sidebar-content"), ".nav-item.active, .project-button.active", ":scope > .nav-glider");
      glide(root.querySelector(".project-navigation .tabs"), "button.active", ":scope > .tab-glider");
      root.querySelectorAll(".segmented-control").forEach(control => glide(control, "button.active", ":scope > .segment-glider"));
    };

    /* --------------------------------------------------------- choreography */
    const entered = new WeakMap<Element, number>();
    const enterBoard = (board: HTMLElement) => {
      if (reduced.matches || Date.now() - (entered.get(board) || 0) < 400) return;
      entered.set(board, Date.now());
      board.querySelectorAll<HTMLElement>(":scope > .kanban-column").forEach((column, columnIndex) => {
        column.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 360, delay: columnIndex * 40, easing: OUT, fill: "backwards" });
        column.querySelectorAll<HTMLElement>(".task-card").forEach((card, cardIndex) => {
          card.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: 60 + columnIndex * 40 + Math.min(cardIndex, 8) * 25, easing: OUT, fill: "backwards" });
        });
      });
    };

    const enterList = (list: HTMLElement, selector: string) => {
      if (reduced.matches) return;
      list.querySelectorAll<HTMLElement>(selector).forEach((row, index) => {
        if (index > 14) return;
        row.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 280, delay: index * 20, easing: OUT, fill: "backwards" });
      });
    };

    const bump = (element: Element) => {
      if (reduced.matches || !(element instanceof HTMLElement)) return;
      element.animate([{ transform: "scale(1)" }, { transform: "scale(1.2)", color: "#ffffff" }, { transform: "scale(1)" }], { duration: 460, easing: SPRING });
    };

    const burst = (x: number, y: number) => {
      if (reduced.matches) return;
      const node = document.createElement("div");
      node.className = "check-burst";
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      for (let index = 0; index < 10; index += 1) {
        const particle = document.createElement("i");
        const angle = (index / 10) * Math.PI * 2 + Math.random() * 0.4;
        const distance = 22 + Math.random() * 16;
        particle.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
        particle.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
        particle.style.setProperty("--tone", index % 2 ? "#3ddc97" : "#f2f2f3");
        node.appendChild(particle);
      }
      overlay.appendChild(node);
      window.setTimeout(() => node.remove(), 900);
    };

    const ghostOut = (card: HTMLElement, box: Box, toward: Element | null) => {
      if (reduced.matches) return;
      const ghost = card.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-task-id");
      ghost.classList.add("motion-ghost");
      Object.assign(ghost.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
      overlay.appendChild(ghost);
      let keyframes: Keyframe[];
      if (toward) {
        const target = boxOf(toward);
        const dx = target.x + target.w / 2 - (box.x + box.w / 2);
        const dy = target.y + target.h / 2 - (box.y + box.h / 2);
        keyframes = [
          { transform: "none", opacity: 1 },
          { transform: "translate3d(0, -6px, 0) scale(1.03)", opacity: 1, offset: 0.18 },
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(.14)`, opacity: 0 },
        ];
      } else {
        keyframes = [{ transform: "none", opacity: 1 }, { transform: "translateX(14px) scale(.96)", opacity: 0 }];
      }
      const animation = ghost.animate(keyframes, { duration: toward ? 760 : 360, easing: toward ? "cubic-bezier(.55, 0, .25, 1)" : "ease-in" });
      animation.onfinish = () => { ghost.remove(); if (toward) bump(toward.querySelector("span") || toward); };
      animation.oncancel = () => ghost.remove();
    };

    /* -------------------------------------------------------------- mutation */
    let glideFrame = 0;
    const scheduleGliders = () => { cancelAnimationFrame(glideFrame); glideFrame = requestAnimationFrame(updateGliders); };

    const observer = new MutationObserver(allRecords => {
      // Ghosts and bursts live in the overlay; their churn must not trigger layout work.
      const records = allRecords.filter(record => !overlay.contains(record.target));
      if (!records.length) return;
      const addedTracked = new Map<string, HTMLElement>();
      const removed: { element: HTMLElement; parent: Node }[] = [];
      let boardEntered: HTMLElement | null = null;
      const lists: [HTMLElement, string][] = [];
      // A whole issue view (the list table or Completed) replacing the board: it enters on its own, with no FLIP from
      // the cards it replaces (cards flying into rows read as a glitch).
      let viewEntered = false;
      let classChanged = false;

      for (const record of records) {
        if (record.type === "characterData") {
          const bumped = record.target.parentElement?.closest(BUMPS);
          if (bumped && record.oldValue !== record.target.nodeValue) bump(bumped);
          continue;
        }
        if (record.type === "attributes") { classChanged = true; continue; }
        // Collapsing a project group removes its active row, so hide the old highlight too.
        if (record.type === "childList") classChanged = true;
        record.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches(".kanban-scroll")) boardEntered = node;
          else if (!boardEntered) { const inner = node.querySelector<HTMLElement>(".kanban-scroll"); if (inner) boardEntered = inner; }
          if (node.matches(".work-issue-list, .archive-list")) lists.push([node, ":scope > *"]);
          const table = node.matches(".issue-table-scroll") ? node : node.querySelector<HTMLElement>(".issue-table-scroll");
          if (table) lists.push([table, ".issue-table tbody tr[data-task-id]"]);
          if (table || node.matches(".archive-list") || node.querySelector(".archive-list")) viewEntered = true;
          const candidates = node.matches(TRACKED) ? [node, ...node.querySelectorAll<HTMLElement>(TRACKED)] : [...node.querySelectorAll<HTMLElement>(TRACKED)];
          candidates.forEach(element => { const key = keyOf(element); if (key) addedTracked.set(key, element); });
        });
        record.removedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          const cards = node.matches("[data-task-id]") ? [node] : [...node.querySelectorAll<HTMLElement>("[data-task-id]")];
          cards.forEach(element => removed.push({ element, parent: record.target }));
        });
      }

      if (reduced.matches) { snapshot(); scheduleGliders(); return; }

      if (boardEntered) {
        enterBoard(boardEntered);
        cache.clear();
        requestAnimationFrame(snapshot);
        scheduleGliders();
        return;
      }
      lists.forEach(([list, selector]) => enterList(list, selector));
      if (viewEntered) {
        cache.clear();
        requestAnimationFrame(snapshot);
        scheduleGliders();
        return;
      }

      // Cards removed while their list stays on screen: completed issues fly to the Completed control.
      // Board cards that complete collapse in place first (project-issues.tsx), so they need no exit ghost.
      const exits = removed.filter(({ element, parent }) => !addedTracked.has(`t:${element.dataset.taskId}`) && !element.classList.contains("is-completing") && canAnimateTaskExit(parent as HTMLElement));
      if (exits.length && exits.length <= 3) {
        exits.forEach(({ element }) => {
          const id = element.dataset.taskId!;
          const box = cache.get(`t:${id}`);
          if (!box) return;
          const done = (completing.get(id) || 0) > Date.now();
          const target = done ? root.querySelector(".segmented-control button:nth-of-type(2)") : null;
          ghostOut(element, box, target);
          completing.delete(id);
        });
      }

      // FLIP every tracked element whose position changed since the last frame we saw.
      const fresh = new Map<string, Box>();
      root.querySelectorAll<HTMLElement>(TRACKED).forEach(element => {
        const key = keyOf(element);
        if (!key) return;
        // Mid-flight rects include the running transform; keep the cached destination instead.
        if (moving(element)) return;
        const next = boxOf(element);
        if (!next.w) return;
        fresh.set(key, next);
        const previous = cache.get(key);
        // Board cards are animated by the board itself (useCardFlip), which also follows drags.
        if (previous && element.dataset.taskId && element.closest(".kanban-scroll")) return;
        if (previous && previous.kind === next.kind) {
          const dx = previous.x - next.x;
          const dy = previous.y - next.y;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
            element.getAnimations().forEach(animation => { if (!(animation as CSSAnimation).animationName) animation.cancel(); });
            element.animate([{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: "none" }], { duration: 560, easing: SPRING, composite: "add" });
          }
        } else if (addedTracked.has(key) && addedTracked.size <= 3 && cache.size) {
          element.animate([{ opacity: 0, transform: "translateY(-10px) scale(.94)" }, { opacity: 1, transform: "none" }], { duration: 520, easing: SPRING });
        }
      });
      fresh.forEach((box, key) => cache.set(key, box));
      if (addedTracked.size || removed.length || classChanged) scheduleGliders();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, characterDataOldValue: true, attributes: true, attributeFilter: ["class", "aria-selected"] });

    /* -------------------------------------------------------------- events */
    const onClick = (event: MouseEvent) => {
      const check = (event.target as Element | null)?.closest<HTMLElement>(".check-button, .work-complete");
      if (!check) return;
      const card = check.closest<HTMLElement>("[data-task-id]");
      const done = check.getAttribute("aria-label")?.startsWith("Complete") ?? true;
      if (!done) return;
      if (card?.dataset.taskId) completing.set(card.dataset.taskId, Date.now() + 4000);
      const rect = check.getBoundingClientRect();
      burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!reduced.matches) check.animate([{ transform: "scale(.7)" }, { transform: "scale(1.18)" }, { transform: "scale(1)" }], { duration: 420, easing: SPRING });
    };
    let scrollFrame = 0;
    const onScroll = () => { cancelAnimationFrame(scrollFrame); scrollFrame = requestAnimationFrame(() => { snapshot(); updateGliders(); }); };

    root.addEventListener("click", onClick, true);
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    void document.fonts?.ready.then(() => { snapshot(); updateGliders(); });

    snapshot();
    updateGliders();
    const board = root.querySelector<HTMLElement>(".kanban-scroll");
    if (board) enterBoard(board);

    return () => {
      observer.disconnect();
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(glideFrame);
      cancelAnimationFrame(scrollFrame);
      overlay.remove();
      delete root.dataset.motion;
    };
  }, []);
  return null;
}
