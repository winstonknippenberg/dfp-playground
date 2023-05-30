/* global window, document, googletag, IntersectionObserver */
import isEqual from 'lodash/isEqual';
import { adTypes, adTargets } from './adManager';
import { CookieUtils } from '@haaretz/htz-user-utils';
import config from 'config';

const siteNumber = config.has('siteNumber') ? config.get('siteNumber') : 80;

const isTM = siteNumber === 10 || siteNumber === 20;

const hiddenClass = 'h-hidden';
let globalConfig;

const observableSlotMap = new WeakMap();
const timeoutSlotMap = new WeakMap();

let bannerObserver;
if (typeof IntersectionObserver !== 'undefined') {
  bannerObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      let timeoutSlot = timeoutSlotMap.get(target);

      if (!timeoutSlot) {
        timeoutSlotMap.set(target, new Map());
        timeoutSlot = timeoutSlotMap.get(target);
      }

      if (isIntersecting) {
        const config = observableSlotMap.get(target);
        if (config.refreshTime) {
          const timeout = setTimeout(() => {
            googletag.pubads().refresh([config.slot]);
            googletag.display(target);
          }, +config.refreshTime * 1000);

          timeoutSlot.set(timeout, timeout);
        }
      } else {
        timeoutSlot.forEach((x) => {
          clearTimeout(x);
        });

        timeoutSlot.clear();
      }
    });
  });
}

export default class AdSlot {
  constructor(adSlotConfig) {
    this.config = Object.assign({}, adSlotConfig);

    globalConfig = globalConfig || this.config.adManager.config;
    // Part I : Markup configuration - passed from AdManager
    this.id = this.config.id;
    if (!this.config.id) {
      throw new Error('an adSlot requires an id!');
    }
    this.target = this.config.target;
    this.type = this.config.type;
    this.responsive = this.config.responsive;
    this.fluid = this.config.fluid;
    this.user = this.config.user;
    this.adManager = this.config.adManager;
    this.htmlElement = this.config.htmlElement;
    this.priority = this.config.priority;
    this.deferredSlot = this.config.deferredSlot;
    this.refreshTime = this.config.refreshTime;

    // Part II : Global, general ad configuration - passed from AdManager
    this.department = this.config.department;
    this.network = this.config.network;
    this.adUnitBase = this.config.adUnitBase;
    this.isWebView = this.config.isWebView;

    if (this.id.includes('mobile_web')) {
      // TODO find a better impl
      this.adUnitBase = this.adUnitBase.replace('.web', '.mobile_web');
    }

    // Part III : ad specific configuration - passed from globalConfig.adSlotConfig
    this.adSizeMapping = this.config.adSizeMapping;
    this.responsiveAdSizeMapping = this.config.responsiveAdSizeMapping;
    this.blacklistReferrers = this.config.blacklistReferrers
      ? this.config.blacklistReferrers.split(',')
      : [];
    this.whitelistReferrers = this.config.whitelistReferrers
      ? this.config.whitelistReferrers.split(',')
      : [];

    // Part IV : Runtime configuration - calculated data - only present in runtime
    this.shown = false;
    this.lastResolvedSize = undefined; // Initialized in 'slotRenderEnded' callback
    this.lastResolvedWithBreakpoint = undefined; // Initialized in 'slotRenderEnded' callback
    this.slot = undefined; // Holds a googletag.Slot object
    // [https://developers.google.com/doubleclick-gpt/reference#googletag.Slot]
    try {
      if (!this.deferredSlot && this.htmlElement) {
        this.slot = this.defineSlot();
      }
    } catch (err) {
      console.error(err); // eslint-disable-line no-console
    }
  }

  /**
   * Checks whether this adSlot is an 'Out-of-page' slot or not.
   * An Out-of-page slot is a slot that is not embedded in the page 'normally'.
   * @returns {boolean} true iff this adSlot is one of the predefined 'out-of-page' slots.
   */
  isOutOfPage() {
    if (typeof this.type !== 'string' && this.type.length < 1) {
      throw new Error('An adSlot cannot by typeless!', this);
    }
    if (this.isMobile() === true) {
      return this.type === adTypes.interstitial;
    }
    switch (this.type) {
      case adTypes.maavaron:
        return false;
      case adTypes.popunder:
        return true;
      case adTypes.talkback:
        return false;
      case adTypes.regular:
        return false;
      default:
        return false;
    }
  }

  /**
   * Checks whether this adSlot is a 'maavaron' slot or not.
   * An Out-of-page slot is a slot that is not embedded in the page 'normally'.
   * @returns {boolean} true iff this adSlot is one of the predefined 'out-of-page' slots.
   */
  isMaavaron() {
    if (typeof this.type !== 'string') {
      throw new Error('An adSlot cannot by typeless!', this);
    }
    if (this.isMobile() === true) {
      return false;
    }
    switch (this.type) {
      case adTypes.maavaron:
        return false;
      default:
        return false;
    }
  }

  isInterstitial() {
    if (typeof this.type !== 'string') {
      throw new Error('An adSlot cannot by typeless!', this);
    }
    if (this.isMobile()) {
      return this.type === adTypes.interstitial;
    }
    return false;
  }

  // eslint-disable-next-line class-methods-use-this
  isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      window.navigator.userAgent || ''
    );
  }

  /**
   * Checks whether or not this adSlot has a non-empty whitelist, and if so, that the current
   * referrer appears in the whitelist.
   * Should return false iff there is a whitelist for the current adSlot, but the referrer is not
   * mentioned in the whitelist.
   * @returns {boolean} true iff the ad can be displayed.
   */
  isWhitelisted() {
    let whitelisted = false;
    if (this.whitelistReferrers.length !== 0) {
      for (const referrer of this.whitelistReferrers) {
        if (globalConfig.referrer.indexOf(referrer) > -1) {
          whitelisted = true;
          break;
        }
      }
    } else {
      whitelisted = true;
    }
    return whitelisted;
  }

  /**
   * Checks whether or not this adSlot has a non-empty blacklist, and if so, that the current
   * referrer does not appear in the blacklist.
   * Should return true iff there is a blacklist for the current adSlot, and the referrer is
   * mentioned in the blacklist - to indicate that the adSlot is 'blocked'.
   * @returns {boolean} true iff the ad cannot be displayed.
   */
  isBlacklisted() {
    let blacklisted = false;
    if (this.blacklistReferrers.length !== 0) {
      for (const referrer of this.blacklistReferrers) {
        if (globalConfig.referrer.indexOf(referrer) > -1) {
          blacklisted = true;
          break;
        }
      }
    }
    return blacklisted;
  }

  /**
   * Shows the current adSlot.
   * It assumes a markup is available for this slot (any tag with an id attribute = this.id)
   */
  show() {
    // Late init: htmlElement was not already defined, and the DOM requirement was met
    if (!this.htmlElement && document.getElementById(this.id)) {
      this.htmlElement = document.getElementById(this.id);
      this.target = this.htmlElement.attributes['data-audtarget']
        ? this.htmlElement.attributes['data-audtarget'].value
        : adTargets.all;
    }
    if (!this.shown === true && (this.htmlElement || this.isInterstitial())) {
      if (isTM && this.isWebView && this.id.includes('.inread')) {
        const cookieMap = CookieUtils.getCookieAsMap();

        if (cookieMap.user && window.googletag && window.googletag.apiReady) {
          // Returns a reference to the pubads service.
          const pubads = googletag.pubads();

          pubads.setTargeting('user', [cookieMap.user]);
        }
      }

      this.shown = true; // Ensure show will be called once per adSlot
      googletag.cmd.push(() => {
        if (this.deferredSlot || !this.slot) {
          this.slot = this.defineSlot();
        }
        this.adManager.DEBUG &&
          console.log(
            'calling show for slot',
            this.id,
            ' called @',
            window.performance.now()
          );

        if (this.htmlElement) {
          this.htmlElement.classList.remove(hiddenClass);

          if (bannerObserver !== undefined && this.refreshTime !== undefined) {
            observableSlotMap.set(this.htmlElement, {
              slot: this.slot,
              refreshTime: this.refreshTime,
            });

            bannerObserver.observe(this.htmlElement);
          }

          if (this.id.includes('interstitial.mobile')) {
            this.adManager.setInterstitialShowingData();
          }

          googletag.display(this.htmlElement); // must be a 'Div' with an id!
        }
        // is interstitial
        else {
          const now = new Date();

          this.adManager.setInterstitialShowingData(now);
          googletag.display(this.slot);
        }
      });
    } else {
      this.adManager.DEBUG &&
        console.error(
          `calling show for an ad slot that ${
            this.shown
              ? 'was already shown!'
              : 'missing a required DOM element!'
          }`,
          this
        );
    }
  }

  /**
   * Shows the current adSlot.
   * It assumes a markup is available for this slot (any tag with an id attribute = this.id)
   */
  hide() {
    googletag.cmd.push(() => {
      if (this.htmlElement) {
        this.htmlElement.classList.add(hiddenClass);
      }
    });
  }

  /**
   * Initializes page-level slot definition for the current slot
   * @return {Slot} slot - the Google Slot that was defined from this AdSlot configuration
   */
  defineSlot() {
    if (this.isMaavaron()) {
      const maavaronSlot = this.defineMaavaron();
      if (this.adManager.shouldSendRequestToDfp(this)) {
        if (!this.shown) {
          this.shown = true; // Ensure show will be called once
          maavaronSlot.display();
        }
      }
      return maavaronSlot;
    }

    if (!this.adManager.shouldSendRequestToDfp(this)) {
      return this;
    }

    const googletag = window.googletag;
    const pubads = googletag.pubads();
    const args = [];
    const defineFn = this.isOutOfPage()
      ? googletag.defineOutOfPageSlot
      : googletag.defineSlot;
    // 3 or 2 params according to the function that we want to activate.
    args.push(this.getPath());
    if (this.isOutOfPage() === false) {
      if (this.fluid) {
        args.push('fluid');
      } else {
        args.push(this.adSizeMapping);
      }
    } else if (this.isInterstitial()) {
      args.push(googletag.enums.OutOfPageFormat.INTERSTITIAL);
    }
    args.push(this.id);
    let slot = defineFn.apply(googletag, args);
    if (slot) {
      // Responsive size Mapping
      if (this.responsive) {
        let responsiveSlotSizeMapping = googletag.sizeMapping();
        const breakpoints = globalConfig.breakpointsConfig.breakpoints;
        const keys = Object.keys(this.responsiveAdSizeMapping);
        for (const key of keys) {
          // ['xxs','xs',...]
          this.responsiveAdSizeMapping[key] = this.responsiveAdSizeMapping[
            key
          ].map((item) => {
            if (isEqual(item, ['fluid'])) {
              return 'fluid';
            }
            return item;
          });
          responsiveSlotSizeMapping.addSize(
            [breakpoints[key], 100], // 100 is a default height, since it is height agnostic
            !isEqual(this.responsiveAdSizeMapping[key], [[0, 0]])
              ? this.responsiveAdSizeMapping[key]
              : []
          );
        }
        responsiveSlotSizeMapping = responsiveSlotSizeMapping.build();
        slot = slot.defineSizeMapping(responsiveSlotSizeMapping);
      }
      slot = slot.addService(pubads);
      if (this.isOutOfPage() === false) {
        slot.setCollapseEmptyDiv(true);
      }
    }
    return slot;
  }

  /**
   * Returns the current path calculated for the adSlot
   * @returns {String} a formatted string that represent the path for the slot definition
   */
  getPath() {
    /* eslint-disable no-shadow */
    let path = globalConfig.path || [];
    path = path.filter((path) => path !== '.');
    path = path
      .map((section) => `${this.id}${this.department}${section}`)
      .join('/');
    // If a path exist, it will be preceded with a forward slash
    path = path && this.config.department !== '_homepage' ? `/${path}` : '';
    /* eslint-enable no-shadow */
    const calculatedPath = `/${this.config.network}/${this.config.adUnitBase}/${this.id}/${this.id}${this.department}${path}`; // eslint-disable-line max-len
    return calculatedPath.toLowerCase();
  }

  /* eslint-disable */
  slotRendered(event) {
    const id = event.slot.getAdUnitPath().split('/')[3]; // Convention: [0]/[1]network/[2]base/[3]id
    const isEmpty = event.isEmpty; // Did the ad return as empty?
    const resolvedSize = event.size; // What 'creative' size did the ad return with?
    // Empty or onload callback should be called next?
  }
  /* eslint-enable */

  /**
   * Refresh this adSlot
   */
  refresh() {
    if (this.htmlElement) {
      googletag.cmd.push(() => {
        googletag.pubads().refresh([this.slot]);
      });
    } else {
      this.adManager.DEBUG &&
        console.error(
          'calling refresh for an ad slot that is missing a required DOM element!',
          this
        );
    }
  }

  /**
   * Shows 'Maavaron' type adSlot using Passback definition
   * @return {Slot} slot - the Google Slot that was defined for Maavaron
   */
  defineMaavaron() {
    if (!document.referrer.match('loc.haaretz')) {
      const adUnitMaavaronPath = this.getPath();
      const adUnitMaavaronSize = [[2, 1]];
      const slot = googletag
        .pubads()
        .definePassback(adUnitMaavaronPath, adUnitMaavaronSize)
        .setTargeting('UserType', [this.user.type])
        .setTargeting('age', [this.user.age])
        .setTargeting('urgdr', [this.user.gender])
        .setTargeting('articleId', [globalConfig.articleId])
        .setTargeting('stg', [globalConfig.environment]);
      return slot;
    }
    return null;
  }

  debug() {
    if (this.slot) {
      googletag.openConsole(this.id);
    } else {
      console.warn(`no slot was defined for slot: ${this.id}`);
    }
  }
}
