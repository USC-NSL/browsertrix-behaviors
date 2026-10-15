import { BackgroundBehavior } from "./lib/behavior";
import { blockWindowOpen, initFlow, nextFlowStep, sleep } from "./lib/utils";
import { RevealClick } from "./revealclick";

// real pointer input through the crawler's flow binding when it is there, so CSS
// :hover applies; synthetic events otherwise, which reach handlers only
const USE_REAL_HOVER = true;

// build-time switches for candidate sources
const USE_HOVER_LISTENERS = true;
const USE_NAV_MENUS = true;
const USE_CSS_HOVER = true;

const LISTENER_EVENTS = [
  "mouseover",
  "mouseenter",
  "pointerover",
  "pointerenter",
];
const NAV_MENU_SELECTOR = "nav li, [aria-haspopup], [aria-expanded]";

// a :hover rule counts when it shows or hides something, or loads an image
const CSS_HOVER_PROPS = ["display", "visibility", "opacity"];

// how long the pointer stays before a hover is judged, for menus that open only
// after a hover-intent delay; RevealClick's activity wait follows
const HOLD_MS = 500;

// the flow binding's hover step pauses this long after moving the pointer
const FLOW_PAUSE_MS = 500;
const FLOW_ID = "autohover";
const HOVER_ATTR = "data-bx-hover";

// submenu levels followed below a top-level candidate
const MAX_DEPTH = 3;

// per-signature hover cap, across re-renders
const MAX_HOVERS = 3;

// stop selecting new elements after this long, the current tree is finished
const MAX_RUN_MS = 120000;

// navigation api is not in the typescript dom lib yet
type NavigateEvent = Event & {
  destination: { sameDocument: boolean; url: string };
};

type FlowResult = { state?: { msg?: string }; done?: boolean };

export class AutoHover extends BackgroundBehavior {
  _donePromise: Promise<void>;
  _markDone!: () => void;
  // clicks nothing: borrows RevealClick's request guard, request tracking,
  // settling, signatures and novelty checks, so both judge reveals the same way
  rc = new RevealClick();
  seenElem = new WeakSet<Element>();
  _listenerElem = new WeakSet<Element>();
  _skippedElem = new WeakSet<Element>();
  _cssHover = new Set<Element>();
  _signatures = new Map<string, { hovers: number; novel: boolean }>();
  _real = USE_REAL_HOVER;
  // where the synthetic pointer is
  _pointer: Element | null = null;
  _tag = 0;
  stats = { hovers: 0, real: 0, synthetic: 0, pathHovers: 0, flowTimeouts: 0 };

  static id = "AutoHover" as const;

  constructor() {
    super();
    this._donePromise = new Promise<void>(
      (resolve) => (this._markDone = resolve),
    );

    if (USE_HOVER_LISTENERS) {
      // runs before page scripts, so sees handlers the page attaches
      const listenerElem = this._listenerElem;
      const addEventListener = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        ...args: Parameters<EventTarget["addEventListener"]>
      ) {
        if (this instanceof Element && LISTENER_EVENTS.includes(args[0])) {
          listenerElem.add(this);
        }
        addEventListener.apply(this, args);
      };
    }
  }

  hasListener(elem: Element) {
    const el = elem as HTMLElement;
    return (
      this._listenerElem.has(elem) ||
      !!(
        el.onmouseover ||
        el.onmouseenter ||
        el.onpointerover ||
        el.onpointerenter
      )
    );
  }

  // elements a same-origin :hover rule applies to: the selector up to the
  // compound carrying :hover. a sheet whose rules cannot be read is
  // cross-origin, and a selector that does not parse once cut is skipped
  scanCssHover() {
    const found = new Set<Element>();
    const scan = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (!(rule instanceof CSSStyleRule)) {
          // @media, @supports, @layer
          if ("cssRules" in rule) {
            scan((rule as CSSGroupingRule).cssRules);
          }
          continue;
        }
        if (!rule.selectorText.includes(":hover")) {
          continue;
        }
        const { style } = rule;
        if (
          !CSS_HOVER_PROPS.some((p) => style.getPropertyValue(p)) &&
          !style.getPropertyValue("background-image").includes("url(")
        ) {
          continue;
        }
        for (const sel of rule.selectorText.split(",")) {
          const target = sel.slice(0, sel.indexOf(":hover")).trim();
          if (!target || /[\s>+~]$/.test(target)) {
            continue;
          }
          try {
            document.querySelectorAll(target).forEach((el) => found.add(el));
          } catch (_) {
            // did not parse once cut
          }
        }
      }
    };
    for (const sheet of [
      ...document.styleSheets,
      ...document.adoptedStyleSheets,
    ]) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue;
      }
      scan(rules);
    }
    this._cssHover = found;
  }

  sources(elem: Element) {
    return [
      USE_HOVER_LISTENERS && this.hasListener(elem) && "listener",
      USE_NAV_MENUS && elem.matches(NAV_MENU_SELECTOR) && "nav-menu",
      USE_CSS_HOVER && this._cssHover.has(elem) && "css-hover",
    ].filter(Boolean);
  }

  isVisible(elem: Element) {
    if (!elem.isConnected || !elem.checkVisibility()) {
      return false;
    }
    // nothing a person could point at
    const { width, height } = elem.getBoundingClientRect();
    return !!width && !!height;
  }

  // a link to another document: hovering it can start a prefetch of that page
  linksAway(elem: Element | null) {
    const link = elem?.closest("a[href]") as HTMLAnchorElement | null;
    return (
      !!link &&
      /^https?:$/.test(link.protocol) &&
      link.href.split("#")[0] !== self.location.href.split("#")[0]
    );
  }

  // every visible element some source marks as reacting to hover
  visibleCandidates() {
    const out: Element[] = [];
    for (const elem of document.body.querySelectorAll("*")) {
      if (this.sources(elem).length && this.isVisible(elem)) {
        out.push(elem);
      }
    }
    return out;
  }

  skipReason(elem: Element) {
    if (this.linksAway(elem)) {
      return "path";
    }
    const seen = this._signatures.get(this.rc.signature(elem));
    if (seen && !(seen.novel && seen.hovers < MAX_HOVERS)) {
      return "seen";
    }
    return null;
  }

  isCandidate(elem: Element) {
    if (this.seenElem.has(elem) || !this.isVisible(elem)) {
      return false;
    }
    const reason = this.skipReason(elem);
    if (reason) {
      // logged once per element, it is rechecked on every scan
      if (!this._skippedElem.has(elem)) {
        this._skippedElem.add(elem);
        this.debug(
          `Skipping element (${reason}): ` + elem.outerHTML.slice(0, 100),
        );
      }
      return false;
    }
    return true;
  }

  // where the pointer lands, checked only for real input: a synthetic event
  // reaches the element whatever is on top of it
  landingReason(elem: Element) {
    elem.scrollIntoView({ block: "center", inline: "center" });
    const rect = elem.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (this.linksAway(hit)) {
      return "path";
    }
    if (!hit || !(hit === elem || elem.contains(hit))) {
      return "covered";
    }
    return null;
  }

  async realHover(elem: Element) {
    const tag = String(++this._tag);
    elem.setAttribute(HOVER_ATTR, tag);
    try {
      const id = await initFlow({
        id: FLOW_ID,
        steps: [
          {
            type: "hover",
            target: self === self.top ? "main" : self.location.href,
            selectors: [[`[${HOVER_ATTR}="${tag}"]`]],
          },
        ],
      });
      if (id === -1) {
        this.debug("No flow binding, hovering with synthetic events");
        this._real = false;
        return false;
      }
      const res = (await nextFlowStep(id)) as FlowResult;
      const msg = res.state?.msg || "";
      if (!msg.endsWith("processed")) {
        if (msg.includes("not found")) {
          this.stats.flowTimeouts++;
        }
        this.debug(
          `Flow hover failed (${msg}), hovering with synthetic events`,
        );
        return false;
      }
      return true;
    } finally {
      elem.removeAttribute(HOVER_ATTR);
    }
  }

  // the events a real move fires: out and leave on what the pointer leaves,
  // over and enter on what it enters, then a move
  syntheticHover(elem: Element) {
    const prev = this._pointer?.isConnected ? this._pointer : null;
    const rect = elem.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    const pointer = (type: string, target: Element, bubbles = true) =>
      target.dispatchEvent(
        new PointerEvent(type, { ...init, bubbles, pointerType: "mouse" }),
      );
    const mouse = (type: string, target: Element, bubbles = true) =>
      target.dispatchEvent(new MouseEvent(type, { ...init, bubbles }));

    if (prev && prev !== elem) {
      const left: Element[] = [];
      for (
        let el: Element | null = prev;
        el && !el.contains(elem);
        el = el.parentElement
      ) {
        left.push(el);
      }
      pointer("pointerout", prev);
      left.forEach((el) => pointer("pointerleave", el, false));
      mouse("mouseout", prev);
      left.forEach((el) => mouse("mouseleave", el, false));
    }

    const entered: Element[] = [];
    for (
      let el: Element | null = elem;
      el && !(prev && el.contains(prev));
      el = el.parentElement
    ) {
      entered.unshift(el);
    }
    pointer("pointerover", elem);
    entered.forEach((el) => pointer("pointerenter", el, false));
    mouse("mouseover", elem);
    entered.forEach((el) => mouse("mouseenter", el, false));
    pointer("pointermove", elem);
    mouse("mousemove", elem);
    this._pointer = elem;
  }

  // moves the pointer onto elem; returns when it arrived and how
  async pointAt(elem: Element) {
    if (this._real) {
      const reason = this.landingReason(elem);
      if (reason) {
        return { arrived: 0, path: `skipped: ${reason}` };
      }
      if (await this.realHover(elem)) {
        return { arrived: Date.now() - FLOW_PAUSE_MS, path: "real" };
      }
    }
    this.syntheticHover(elem);
    return { arrived: Date.now(), path: "synthetic" };
  }

  async hoverElem(elem: Element, observer: PerformanceObserver, depth: number) {
    const hoverStarted = Date.now();
    this.debug(
      `Hovering on element (${this.sources(elem).join(", ")}) [depth ${depth}]: ` +
        elem.outerHTML.slice(0, 100),
    );
    this.rc._foundNewResource = false;
    const { arrived, path } = await this.pointAt(elem);
    if (!arrived) {
      this.debug(
        `Skipping element (${path.slice(9)}): ` + elem.outerHTML.slice(0, 100),
      );
      return { novel: false, changed: false };
    }

    // waitForQuiet waits 250ms itself before it looks
    await sleep(HOLD_MS - 250 - (Date.now() - arrived));
    const waited = await this.rc.waitForQuiet(arrived);

    this.rc.addResources(observer.takeRecords());
    const novel = this.rc.addVisibleText() || this.rc._foundNewResource;
    const changed = novel || this.rc._lastMutation >= arrived;

    const signature = this.rc.signature(elem);
    const state = this._signatures.get(signature) || {
      hovers: 0,
      novel: false,
    };
    state.hovers++;
    state.novel = novel;
    this._signatures.set(signature, state);

    this.stats.hovers++;
    this.stats[path === "real" ? "real" : "synthetic"]++;
    this.debug(
      `Hovered (${path}) in ${Date.now() - hoverStarted}ms ` +
        `[waited ${waited}ms]: ${novel ? "new content" : "nothing new"}`,
    );
    return { novel, changed };
  }

  // hover elem, then whatever its hover uncovered, depth first, while it is
  // open. later siblings are reached again through the whole chain, since
  // exploring one may have closed part of it
  async hoverTree(
    elem: Element,
    chain: Element[],
    observer: PerformanceObserver,
    started: number,
  ) {
    this.seenElem.add(elem);
    const before = new Set(this.visibleCandidates());
    const { changed } = await this.hoverElem(elem, observer, chain.length);
    if (!changed || chain.length >= MAX_DEPTH) {
      return;
    }
    const children = this.visibleCandidates().filter(
      (el) => !before.has(el) && this.isCandidate(el),
    );
    const path = [...chain, elem];
    for (const [i, child] of children.entries()) {
      if (Date.now() - started > MAX_RUN_MS) {
        return;
      }
      if (i) {
        for (const el of path) {
          if (!this.isVisible(el)) {
            return;
          }
          this.stats.pathHovers++;
          await this.pointAt(el);
        }
        await sleep(HOLD_MS);
      }
      if (!this.isVisible(child)) {
        continue;
      }
      await this.hoverTree(child, path, observer, started);
    }
  }

  nextElem(): Element | null {
    try {
      for (const elem of this.visibleCandidates()) {
        if (this.isCandidate(elem)) {
          return elem;
        }
      }
    } catch (e) {
      this.debug((e as Error).toString());
    }
    return null;
  }

  async start() {
    // a cross-origin frame is someone else's page (a consent manager, an ad)
    try {
      void self.top?.document;
    } catch (_) {
      this.debug("Skipping cross-origin frame: " + self.location.href);
      this._markDone();
      return;
    }

    const started = Date.now();

    await this.rc.settle();

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      return false;
    };
    window.addEventListener("beforeunload", beforeUnload);

    this.rc._blockWrites = true;

    // cancels cross-document navigation before unload, without a dialog
    const navigate = (event: Event) => {
      const { destination } = event as NavigateEvent;
      if (!destination.sameDocument) {
        this.debug("Blocked navigation to: " + destination.url);
        event.preventDefault();
      }
    };
    const navigation = (self as unknown as { navigation?: EventTarget })
      .navigation;
    navigation?.addEventListener("navigate", navigate);

    // a popup is a page load nobody asked for
    const releaseOpen = blockWindowOpen((msg) => this.debug(msg));

    // the hover tag is ours, not something the page did
    const mutations = new MutationObserver((records) => {
      if (records.some((r) => r.attributeName !== HOVER_ATTR)) {
        this.rc._lastMutation = Date.now();
      }
    });
    mutations.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    const observer = new PerformanceObserver((list) =>
      this.rc.addResources(list.getEntries()),
    );
    observer.observe({ type: "resource" });
    this.rc.addResources(performance.getEntriesByType("resource"));
    this.rc.addVisibleText();

    if (USE_CSS_HOVER) {
      this.scanCssHover();
    }

    while (Date.now() - started < MAX_RUN_MS) {
      const elem = this.nextElem();
      if (!elem) {
        this.debug("No more elements");
        break;
      }
      await this.hoverTree(elem, [], observer, started);
      if (USE_CSS_HOVER) {
        this.scanCssHover();
      }
    }
    if (Date.now() - started >= MAX_RUN_MS) {
      this.debug("Time budget reached");
    }

    const { hovers, real, synthetic, pathHovers, flowTimeouts } = this.stats;
    this.debug(
      `AutoHover done in ${Date.now() - started}ms: ${hovers} hovers ` +
        `(${real} real, ${synthetic} synthetic), ${pathHovers} path hovers, ` +
        `${flowTimeouts} flow timeouts`,
    );

    observer.disconnect();
    mutations.disconnect();

    navigation?.removeEventListener("navigate", navigate);

    releaseOpen();

    this.rc._blockWrites = false;

    window.removeEventListener("beforeunload", beforeUnload);

    this._markDone();
  }

  async done() {
    return this._donePromise;
  }
}
