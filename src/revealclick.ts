import { BackgroundBehavior } from "./lib/behavior";
import { sleep } from "./lib/utils";

// build-time variant switches for candidate sources beyond native controls
const USE_CURSOR_POINTER = true;
const USE_CLICK_LISTENERS = true;

// per-element click cap, 1 disables repeat clicking
const MAX_CLICKS = 10;

// wait for the page to go quiet before the first scan, 0 disables settling
const MAX_SETTLE_MS = 5000;
const QUIET_MS = 1000;

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
  _foundNewResource = false;
  // writes are blocked only while start() runs, the page's own load is untouched
  _blockWrites = false;

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

    const fetch = self.fetch;
    self.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const [input, init] = args;
      const request = input instanceof Request ? input : null;
      const method = init?.method || request?.method || "GET";
      const url = request ? request.url : String(input);
      if (blocked(method, url, init?.body)) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return fetch.apply(this, args);
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
      return ops.every((op) => {
        const query = (op as { query?: unknown } | null)?.query;
        if (typeof query !== "string") {
          return false;
        }
        const text = query.replace(/#[^\n]*/g, "").trim();
        return (
          (text.startsWith("{") || /^query\b/.test(text)) &&
          !/(^|[}\s])(mutation|subscription)\b/.test(text)
        );
      });
    } catch (e) {
      return false;
    }
  }

  unsafeReason(elem: Element) {
    if (elem.closest("form")) {
      return "form";
    }
    if (elem.matches("[type=submit]")) {
      return "submit";
    }
    const labelIds = elem.getAttribute("aria-labelledby")?.split(/\s+/) || [];
    // accessible name precedence, approximately
    const name = (
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
    // only same-document links, following others would unload the page
    const link = elem.closest("a[href]") as HTMLAnchorElement | null;
    const reason =
      link && link.href.split("#")[0] !== self.location.href.split("#")[0]
        ? "path"
        : this.unsafeReason(elem);
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

  addResources(entries: PerformanceEntryList) {
    for (const entry of entries) {
      if (!this._seenResources.has(entry.name)) {
        this._seenResources.add(entry.name);
        this._foundNewResource = true;
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
    const navigation = (self as unknown as { navigation?: EventTarget })
      .navigation;

    navigation?.addEventListener("navigate", navigate);

    // a popup is a page load nobody asked for
    const open = window.open;
    window.open = (url?: string | URL) => {
      this.debug("Blocked window.open: " + String(url));
      return null;
    };

    const observer = new PerformanceObserver((list) =>
      this.addResources(list.getEntries()),
    );
    observer.observe({ type: "resource" });
    this.addResources(performance.getEntriesByType("resource"));
    this.addVisibleText();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-constant-condition
    while (true) {
      const elem = this.nextElem();

      if (!elem) {
        break;
      }

      // every enabled source that matches, not just the one that found it
      const sources = [
        elem.matches(this.selector) && "native",
        USE_CURSOR_POINTER && this.isPointer(elem) && "cursor-pointer",
        USE_CLICK_LISTENERS && this.hasListener(elem) && "listener",
      ].filter(Boolean);

      this.debug(
        `Clicking on element (${sources.join(", ")}): ` +
          elem.outerHTML.slice(0, 100),
      );

      // keep clicking while each click reveals something new
      let clicks = 1;
      while (
        (await this.processElem(elem, observer)) &&
        clicks < this.maxClicks &&
        elem.isConnected &&
        elem.checkVisibility() &&
        !this.unsafeReason(elem)
      ) {
        clicks++;
      }

      this.debug(`Clicked ${clicks} times`);
    }

    observer.disconnect();

    navigation?.removeEventListener("navigate", navigate);

    window.open = open;

    this._blockWrites = false;

    window.removeEventListener("beforeunload", beforeUnload);

    this._markDone();
  }

  async processElem(elem: Element, observer: PerformanceObserver) {
    const origHref = self.location.href;
    const origHistoryLen = self.history.length;

    const rect = elem.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };

    this._foundNewResource = false;

    for (const type of CLICK_EVENTS) {
      elem.dispatchEvent(
        type.startsWith("pointer")
          ? new PointerEvent(type, { ...init, pointerType: "mouse" })
          : new MouseEvent(type, init),
      );
    }

    await sleep(250);

    this.addResources(observer.takeRecords());
    const foundNew = this.addVisibleText() || this._foundNewResource;

    if (self.location.href === origHref) {
      return foundNew;
    }

    this.debug("Click changed URL, restoring: " + self.location.href);

    if (self.history.length === origHistoryLen + 1) {
      await new Promise((resolve) => {
        window.addEventListener(
          "popstate",
          () => {
            resolve(null);
          },
          { once: true },
        );

        window.history.back();
      });
    } else {
      self.history.replaceState(self.history.state, "", origHref);
    }

    return false;
  }

  async done() {
    return this._donePromise;
  }
}
