import { BackgroundBehavior } from "./lib/behavior";
import { sleep } from "./lib/utils";

// build-time variant switches for candidate sources beyond native controls
const USE_CURSOR_POINTER = true;
const USE_CLICK_LISTENERS = true;

// also click links to an image or video that have a click listener (a lightbox
// opening image.jpg): the navigation guard cancels the navigation before unload.
// other links with a listener are mostly router links, which change the route
const CLICK_LISTENER_LINKS = false;
const MEDIA_PATH = /\.(jpe?g|png|gif|webp|avif|svg|bmp|mp4|webm|mov|m4v|ogv)$/i;

// per-element click cap, 1 disables repeat clicking
const MAX_CLICKS = 10;

// wait for the page to go quiet before the first scan, 0 disables settling
const MAX_SETTLE_MS = 5000;
const QUIET_MS = 1000;

// after a click: at least MIN_WAIT_MS, then while a fetch/XHR the click started
// is in flight or the DOM changed within WAIT_QUIET_MS, up to MAX_WAIT_MS
const MIN_WAIT_MS = 250;
const WAIT_QUIET_MS = 250;
const MAX_WAIT_MS = 2500;

const TRAVERSE_TIMEOUT_MS = 2000;

// stop selecting new elements after this long, the current one is finished
const MAX_RUN_MS = 120000;

const LISTENER_EVENTS = ["click", "mousedown", "pointerdown"];

// matched against the element's own name only, not surrounding text.
// phrases name the action itself, so they apply at any name length
const UNSAFE_PHRASE =
  /\b(add\b.{0,80}?\bto\s+(cart|bag|basket|wish\s?list|favou?rites?)|buy|check\s?out|wish\s?list|favou?rites?|rate\s+this|rate|ratings?|vote|not\s+helpful|helpful)\b/i;
// generic words, common in harmless text, so only for short names
const UNSAFE_WORD =
  /\b(post|submit|delete|subscribe|unsubscribe|sign in|report|like|save|follow|comment|reply)\b/i;

// a longer name is a card or region named by its content, not a control label
const MAX_LABEL_WORDS = 4;

// links never followed, whatever the other rules allow
const UNSAFE_LINK_PATH = /\/(cart|checkout|account|login|signin|subscribe)\b/i;

// stream segments and manifests keep arriving while a player runs, they say
// nothing about whether a click revealed something
const MEDIA_SEGMENT =
  /\.(m3u8|mpd|ts|m4s|m4a|m4v|mp4|webm|aac|vtt|cmfv|cmfa)$/i;

// an element's signature: ids that look generated per render are not anchors,
// and only attributes that stay the same across renders are compared
const GENERATED_ID =
  /\d{3,}|:|[0-9a-f]{8}|^(ember|react|rc|mui|radix|headlessui|ng)[-_]/i;
const STABLE_ATTRS = ["type", "href", "name", "title", "data-testid"];

const CONSENT_BANNER =
  /cookie|consent|gdpr|onetrust|cookiebot|didomi|\bcmp\b|privacy-banner/i;

// reads that use POST, allowed while writes are blocked: search queries, and
// google grpc-web methods named as reads
const ALLOWED_POST = [
  /(^|\.)algolia(net)?\.(net|com|io)\/1\/indexes\/[^/]+\/(query|queries)$/i,
  /(^|\.)googleapis\.com\/\$rpc\/[^/]+\/(Get|List|Search|BatchGet)\w*$/,
];

// navigation api is not in the typescript dom lib yet
type NavigateEvent = Event & {
  destination: { sameDocument: boolean; url: string };
};
type Navigation = EventTarget & {
  currentEntry: { key: string } | null;
  traverseTo: (key: string) => { finished: Promise<unknown> };
};

const CLICK_EVENTS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
];

export class RevealClick extends BackgroundBehavior {
  _donePromise: Promise<void>;
  _markDone!: () => void;
  selector: string;
  maxClicks: number;
  seenElem = new WeakSet<Element>();
  _listenerElem = new WeakSet<Element>();
  _skippedElem = new WeakSet<Element>();
  // session-wide, so an element that cycles back to seen content stops
  _seenResources = new Set<string>();
  _seenText = new Set<string>();
  // per signature, so a re-rendered control is known again: clicks so far, and
  // whether the last click revealed something
  _signatures = new Map<string, { clicks: number; novel: boolean }>();
  _foundNewResource = false;
  // writes are blocked only while start() runs, the page's own load is untouched
  _blockWrites = false;
  // fetch/XHR requests in flight, by start time, and the last DOM change
  _inFlight = new Map<object, number>();
  _lastMutation = 0;
  // a click replaced the route: the page's router no longer matches its url
  _routeReplaced = false;

  static id = "RevealClick" as const;

  constructor(
    selector = "button, summary, [role=button], [role=tab]",
    maxClicks = MAX_CLICKS,
  ) {
    super();
    this.selector = selector;
    this.maxClicks = maxClicks;
    this._donePromise = new Promise<void>(
      (resolve) => (this._markDone = resolve),
    );

    if (USE_CLICK_LISTENERS) {
      // runs before page scripts, so sees handlers the page attaches
      const listenerElem = this._listenerElem;
      const addEventListener = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        ...args: Parameters<EventTarget["addEventListener"]>
      ) {
        // document and window are root delegation, covered by cursor: pointer
        if (this instanceof Element && LISTENER_EVENTS.includes(args[0])) {
          listenerElem.add(this);
        }
        addEventListener.apply(this, args);
      };
    }

    // wrapped before page scripts run, so they only ever see these versions
    const blocked = (method: string, url: string | URL, body?: unknown) => {
      if (
        !this._blockWrites ||
        ["GET", "HEAD"].includes(method.toUpperCase()) ||
        this.isAllowedWrite(String(url), body)
      ) {
        return false;
      }
      this.debug(`Blocked ${method.toUpperCase()} request: ${String(url)}`);
      return true;
    };

    const inFlight = this._inFlight;
    const fetch = self.fetch;
    self.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const [input, init] = args;
      const request = input instanceof Request ? input : null;
      const method = init?.method || request?.method || "GET";
      const url = request ? request.url : String(input);
      if (blocked(method, url, init?.body)) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      const token = {};
      inFlight.set(token, Date.now());
      return fetch.apply(this, args).finally(() => inFlight.delete(token));
    };

    const xhrMethod = new WeakMap<XMLHttpRequest, [string, string]>();
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      xhrMethod.set(this, [method, String(url)]);
      open.apply(this, [method, url, ...rest] as Parameters<typeof open>);
    };
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const [method, url] = xhrMethod.get(this) || ["GET", ""];
      if (!blocked(method, url, body)) {
        inFlight.set(this, Date.now());
        this.addEventListener("loadend", () => inFlight.delete(this), {
          once: true,
        });
        send.call(this, body);
      }
    };

    const sendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) =>
      !blocked("POST", url, data) && sendBeacon(url, data);

    const submit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      if (!blocked(this.method, this.action)) {
        submit.call(this);
      }
    };
    const requestSubmit = HTMLFormElement.prototype.requestSubmit;
    HTMLFormElement.prototype.requestSubmit = function (
      this: HTMLFormElement,
      submitter?: HTMLElement | null,
    ) {
      if (!blocked(this.method, this.action)) {
        requestSubmit.call(this, submitter);
      }
    };
  }

  isAllowedWrite(url: string, body: unknown) {
    try {
      const { host, pathname } = new URL(url, self.location.href);
      if (ALLOWED_POST.some((re) => re.test(host + pathname))) {
        return true;
      }
    } catch (e) {
      return false;
    }
    if (typeof body !== "string") {
      return false;
    }
    // a graphql query reads, a mutation or subscription writes, unsure blocks
    try {
      const data: unknown = JSON.parse(body);
      const ops = Array.isArray(data) ? (data as unknown[]) : [data];
      return (
        ops.length > 0 &&
        ops.every((op) => {
          const query = (op as { query?: unknown } | null)?.query;
          if (typeof query !== "string") {
            return false;
          }
          const text = query.replace(/#[^\n]*/g, "").trim();
          return (
            (text.startsWith("{") || /^query\b/.test(text)) &&
            !/(^|[}\s])(mutation|subscription)\b/.test(text)
          );
        })
      );
    } catch (e) {
      return false;
    }
  }

  accessibleName(elem: Element) {
    const labelIds = elem.getAttribute("aria-labelledby")?.split(/\s+/) || [];
    // accessible name precedence, approximately
    return (
      labelIds
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ")
        .trim() ||
      elem.getAttribute("aria-label") ||
      elem.textContent?.trim() ||
      (elem as HTMLInputElement).value ||
      elem.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  // the same control after a re-render: its path from the nearest ancestor with
  // a stable id, as tag:nth-of-type steps, and its role, name and attributes
  signature(elem: Element) {
    const path: string[] = [];
    for (
      let el: Element | null = elem;
      el && el !== document.body;
      el = el.parentElement
    ) {
      if (el.id && !GENERATED_ID.test(el.id)) {
        path.unshift("#" + el.id);
        break;
      }
      const tag = el.tagName;
      const same = el.parentElement
        ? [...el.parentElement.children].filter((c) => c.tagName === tag)
        : [el];
      path.unshift(`${tag.toLowerCase()}:${same.indexOf(el) + 1}`);
    }
    return [
      path.join(">"),
      elem.getAttribute("role") || "",
      this.accessibleName(elem).slice(0, 100),
      ...STABLE_ATTRS.map((a) => elem.getAttribute(a) || ""),
    ].join("|");
  }

  unsafeReason(elem: Element) {
    // a disabled control can still have a live handler (a "previous" button on
    // page 1 that loads page 0): a person would not press it
    if (elem.matches('[disabled], [aria-disabled="true"]')) {
      return "disabled";
    }
    if (elem.closest("form")) {
      return "form";
    }
    if (elem.matches("[type=submit]")) {
      return "submit";
    }
    const name = this.accessibleName(elem);
    const match =
      UNSAFE_PHRASE.exec(name) ||
      (name.split(" ").length <= MAX_LABEL_WORDS && UNSAFE_WORD.exec(name));
    if (match) {
      return `label "${match[0]}": ${name}`;
    }
    if (
      /\b(accept|agree|allow|reject)\b/i.test(name) &&
      /\b(cookies?|consent)\b/i.test(name)
    ) {
      return "consent";
    }
    for (let el: Element | null = elem; el; el = el.parentElement) {
      const attrs = ["id", "class", "role", "aria-label"].map((a) =>
        el?.getAttribute(a),
      );
      if (CONSENT_BANNER.test(attrs.join(" "))) {
        return "consent";
      }
    }
    return null;
  }

  isCandidate(elem: Element) {
    if (
      this.seenElem.has(elem) ||
      !elem.isConnected ||
      !elem.checkVisibility()
    ) {
      return false;
    }
    // nothing a person could click (an empty portal div a framework keeps adding)
    const { width, height } = elem.getBoundingClientRect();
    if (!width || !height) {
      return false;
    }
    // only same-document links, following others would unload the page
    const link = elem.closest("a[href]") as HTMLAnchorElement | null;
    const otherDocument =
      link && link.href.split("#")[0] !== self.location.href.split("#")[0];
    const unsafeLink =
      link &&
      (["mailto:", "tel:"].includes(link.protocol) ||
        UNSAFE_LINK_PATH.test(link.pathname));
    const reason =
      unsafeLink ||
      (otherDocument &&
        !(
          CLICK_LISTENER_LINKS &&
          MEDIA_PATH.test(link.pathname) &&
          (this.hasListener(link) || this.hasListener(elem))
        ))
        ? "path"
        : this.unsafeReason(elem) || this.seenReason(elem);
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
    this.seenElem.add(elem);
    return true;
  }

  // a control seen before under another node is clicked again only while it is
  // still revealing (a load-more rebuilt after each batch), up to the click cap
  seenReason(elem: Element) {
    const seen = this._signatures.get(this.signature(elem));
    if (seen && !(seen.novel && seen.clicks < this.maxClicks)) {
      return "seen";
    }
    return null;
  }

  addResources(entries: PerformanceEntryList) {
    for (const entry of entries) {
      if (!this._seenResources.has(entry.name)) {
        this._seenResources.add(entry.name);
        if (!MEDIA_SEGMENT.test(entry.name.split(/[?#]/)[0])) {
          this._foundNewResource = true;
        }
      }
    }
  }

  // records all visible text, true if any of it was not seen before
  addVisibleText() {
    let found = false;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim();
      if (
        text &&
        !this._seenText.has(text) &&
        walker.currentNode.parentElement?.checkVisibility()
      ) {
        this._seenText.add(text);
        found = true;
      }
    }
    return found;
  }

  // cursor is inherited, only take the outermost pointer element
  isPointer(elem: Element) {
    return (
      getComputedStyle(elem).cursor === "pointer" &&
      !(
        elem.parentElement &&
        getComputedStyle(elem.parentElement).cursor === "pointer"
      )
    );
  }

  hasListener(elem: Element) {
    return this._listenerElem.has(elem) || !!(elem as HTMLElement).onclick;
  }

  nextElem(): Element | null {
    try {
      for (const elem of document.querySelectorAll(this.selector)) {
        if (this.isCandidate(elem)) {
          return elem;
        }
      }

      const allElems = document.body.querySelectorAll("*");

      if (USE_CURSOR_POINTER) {
        for (const elem of allElems) {
          if (
            !this.seenElem.has(elem) &&
            this.isPointer(elem) &&
            this.isCandidate(elem)
          ) {
            return elem;
          }
        }
      }

      if (USE_CLICK_LISTENERS) {
        for (const elem of allElems) {
          if (this.hasListener(elem) && this.isCandidate(elem)) {
            return elem;
          }
        }
      }
    } catch (e) {
      this.debug((e as Error).toString());
    }

    return null;
  }

  // server-rendered pages attach handlers after load, and a click that does
  // nothing yet would mark the element done, so wait for dom and network quiet
  async settle() {
    const started = Date.now();
    let last = started;
    const mutations = new MutationObserver(() => (last = Date.now()));
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const resources = new PerformanceObserver(() => (last = Date.now()));
    resources.observe({ type: "resource" });

    while (
      Date.now() - last < QUIET_MS &&
      Date.now() - started < MAX_SETTLE_MS
    ) {
      await sleep(100);
    }

    mutations.disconnect();
    resources.disconnect();
    this.debug(`Waited ${Date.now() - started}ms for the page to settle`);
  }

  async start() {
    // a cross-origin frame is someone else's page (a consent manager, an ad):
    // only the top frame and frames same-origin with it are clicked
    try {
      void self.top?.document;
    } catch (e) {
      this.debug("Skipping cross-origin frame: " + self.location.href);
      this._markDone();
      return;
    }

    const started = Date.now();

    if (MAX_SETTLE_MS) {
      await this.settle();
    }

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      return false;
    };

    window.addEventListener("beforeunload", beforeUnload);

    this._blockWrites = true;

    // cancels cross-document navigation before unload, without a dialog
    const navigate = (event: Event) => {
      const { destination } = event as NavigateEvent;
      if (!destination.sameDocument) {
        this.debug("Blocked navigation to: " + destination.url);
        event.preventDefault();
      }
    };
    const navigation = (self as unknown as { navigation?: Navigation })
      .navigation;

    navigation?.addEventListener("navigate", navigate);

    // a popup is a page load nobody asked for
    const open = window.open;
    window.open = (url?: string | URL) => {
      this.debug("Blocked window.open: " + String(url));
      return null;
    };

    const mutations = new MutationObserver(
      () => (this._lastMutation = Date.now()),
    );
    mutations.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    const observer = new PerformanceObserver((list) =>
      this.addResources(list.getEntries()),
    );
    observer.observe({ type: "resource" });
    this.addResources(performance.getEntriesByType("resource"));
    this.addVisibleText();

    while (!this._routeReplaced) {
      if (Date.now() - started > MAX_RUN_MS) {
        this.debug("Time budget reached");
        break;
      }

      const scanStarted = Date.now();
      const elem = this.nextElem();
      const scanMs = Date.now() - scanStarted;

      if (!elem) {
        this.debug(`No more elements (scan ${scanMs}ms)`);
        break;
      }

      // every enabled source that matches, not just the one that found it
      const sources = [
        elem.matches(this.selector) && "native",
        USE_CURSOR_POINTER && this.isPointer(elem) && "cursor-pointer",
        USE_CLICK_LISTENERS && this.hasListener(elem) && "listener",
      ].filter(Boolean);

      this.debug(
        `Clicking on element (${sources.join(", ")}) [scan ${scanMs}ms]: ` +
          elem.outerHTML.slice(0, 100),
      );

      // keep clicking while each click reveals something new, the cap counts
      // every click on this signature, across re-renders
      const signature = this.signature(elem);
      const state = this._signatures.get(signature) || {
        clicks: 0,
        novel: false,
      };
      this._signatures.set(signature, state);
      const durations: number[] = [];
      const waits: number[] = [];
      const timedClick = async () => {
        const clickStarted = Date.now();
        const foundNew = await this.processElem(elem, observer, waits);
        durations.push(Date.now() - clickStarted);
        state.clicks++;
        state.novel = foundNew;
        return foundNew;
      };
      let clicks = 1;
      while (
        (await timedClick()) &&
        !this._routeReplaced &&
        state.clicks < this.maxClicks &&
        elem.isConnected &&
        elem.checkVisibility() &&
        !this.unsafeReason(elem)
      ) {
        clicks++;
      }

      this.debug(
        `Clicked ${clicks} times (${durations.join(", ")}ms) ` +
          `[waited ${waits.join(", ")}ms]`,
      );
    }

    observer.disconnect();
    mutations.disconnect();

    navigation?.removeEventListener("navigate", navigate);

    window.open = open;

    this._blockWrites = false;

    window.removeEventListener("beforeunload", beforeUnload);

    this._markDone();
  }

  // what a click set off: the fetches it started, and the DOM changes they bring
  async waitForQuiet(clicked: number) {
    await sleep(MIN_WAIT_MS);
    while (Date.now() - clicked < MAX_WAIT_MS) {
      const busy = [...this._inFlight.values()].some((t) => t >= clicked);
      if (!busy && Date.now() - this._lastMutation >= WAIT_QUIET_MS) {
        break;
      }
      await sleep(50);
    }
    return Date.now() - clicked;
  }

  async processElem(
    elem: Element,
    observer: PerformanceObserver,
    waits: number[],
  ) {
    const navigation = (self as unknown as { navigation?: Navigation })
      .navigation;
    const origHref = self.location.href;
    const origState: unknown = self.history.state;
    const origKey = navigation?.currentEntry?.key;

    const rect = elem.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };

    this._foundNewResource = false;

    const clicked = Date.now();
    for (const type of CLICK_EVENTS) {
      elem.dispatchEvent(
        type.startsWith("pointer")
          ? new PointerEvent(type, { ...init, pointerType: "mouse" })
          : new MouseEvent(type, init),
      );
    }

    waits.push(await this.waitForQuiet(clicked));

    this.addResources(observer.takeRecords());
    const foundNew = this.addVisibleText() || this._foundNewResource;

    if (self.location.href === origHref) {
      return foundNew;
    }

    // a query or fragment is in-page state (?page=2, a hash tab, an anchor):
    // undoing it can make the router redraw what the click revealed
    const { origin, pathname } = new URL(origHref);
    if (
      self.location.origin === origin &&
      self.location.pathname === pathname
    ) {
      this.debug(
        "Click changed query or fragment, keeping: " + self.location.href,
      );
      return foundNew;
    }

    this.debug("Click changed URL, restoring: " + self.location.href);

    // frames share one session history, so a frame never traverses it
    if (self.top !== self) {
      self.history.replaceState(origState, "", origHref);
      return false;
    }

    // a push keeps the original entry, so traverse back to exactly that one
    // and the page's router follows the popstate. a replace overwrote it
    let restored = false;
    if (navigation && origKey && navigation.currentEntry?.key !== origKey) {
      // finished resolves before the popstate, so wait for the popstate
      restored = await Promise.race([
        new Promise<boolean>((resolve) => {
          window.addEventListener("popstate", () => resolve(true), {
            once: true,
          });
          navigation.traverseTo(origKey).finished.catch(() => resolve(false));
        }),
        sleep(TRAVERSE_TIMEOUT_MS).then(() => false),
      ]);
      if (!restored) {
        this.debug(`No traversal within ${TRAVERSE_TIMEOUT_MS}ms`);
      }
    }

    if (!restored) {
      self.history.replaceState(origState, "", origHref);
      this.debug("Route replaced, stopping");
      this._routeReplaced = true;
    }

    return false;
  }

  async done() {
    return this._donePromise;
  }
}
