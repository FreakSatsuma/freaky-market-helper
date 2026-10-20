// ==UserScript==
// @name         Freaky Market Helper
// @namespace    https://www.torn.com/profiles.php?XID=4313844
// @version      1.6.6
// @description  Fill your Torn Item Market and Bazaar listings in one click. Prices from the cheapest listing, average price, market value or live bazaars (weav3r.dev), with your own formulas and min/max ranges, quantity rules, favourites with Fill All, a session receipt and a dollar bazaar mode. Settings are kept separately for the Item Market and the Bazaar.
// @author       FreakSatsuma [4313844]
// @license      MIT License
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @match        https://*.torn.com/page.php?sid=ItemMarket*
// @match        https://www.torn.com/bazaar.php*
// @match        https://*.torn.com/bazaar.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      weav3r.dev
// ==/UserScript==

/*
 * Freaky Market Helper
 * Copyright (c) 2026 FreakSatsuma [4313844]
 *
 * Based on "Torn Market Filler" by Silmaril [2665762], MIT License. The Bazaar click-to-fill
 * behaviour follows the idea of "Bazaar Auto Price" by tos and Lugburz.
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

(async function() {
    'use strict';

    // One-time carry-over from the previous name: copies saved settings (favourites, formulas,
    // receipt, API key...) to this script's own keys, never overwriting anything already there.
    // The old keys are left untouched in case the original script is still installed.
    try {
        const OLD_PREFIX = 'silmaril-torn-market-filler-';
        const NEW_PREFIX = 'freaky-market-helper-';
        Object.keys(localStorage).forEach(function(key){
            if (key.indexOf(OLD_PREFIX) === 0){
                const target = NEW_PREFIX + key.substring(OLD_PREFIX.length);
                if (localStorage.getItem(target) === null){
                    localStorage.setItem(target, localStorage.getItem(key));
                }
            }
        });
        const oldApiKey = localStorage.getItem('silmaril-torn-bazaar-filler-apikey');
        if (oldApiKey !== null && localStorage.getItem('freaky-market-helper-apikey') === null){
            localStorage.setItem('freaky-market-helper-apikey', oldApiKey);
        }
    } catch (error) {
        // Blocked storage: nothing to carry over.
    }

    // Keep in sync with @version above — it keys the "What's new" popup.
    const SCRIPT_VERSION = "1.6.6";

    const itemUrl = "https://api.torn.com/torn/{itemId}?selections=items&key={apiKey}&comment=MarketFiller";
    const marketUrlV2 = "https://api.torn.com/v2/market?id={itemId}&selections=itemMarket&key={apiKey}&comment=MarketFiller";
    // weav3r.dev aggregates live player-bazaar listings. Public and needs no API key, but it is
    // a third-party host, and a request the Torn page issues itself has to satisfy both Torn's
    // Content-Security-Policy and weav3r's CORS headers — which is why a plain fetch to it never
    // got off the ground. Every weav3r call therefore goes through the userscript manager's
    // cross-origin transport (see requestJson), which runs outside the page and is bound by
    // neither. weav3r is also shared across every consumer at 100 req/min, so responses are
    // cached client-side too.
    const weav3rItemUrl = "https://weav3r.dev/api/marketplace/{itemId}";
    const weav3rAllUrl = "https://weav3r.dev/api/marketplace";

    // Which endpoint a formula's price comes from.
    const SOURCE_ITEM_MARKET = "itemmarket";  // Torn live item market listings (default)
    const SOURCE_MARKET_VALUE = "items";      // Torn market value, i.e. [market]
    const SOURCE_BAZAAR = "bazaar";           // weav3r player bazaars, i.e. [bazaar...]

    // weav3r serves its own cache with a 30-180s TTL, so re-asking sooner than this only burns
    // rate limit. The bulk snapshot covers every item at once and backs [bazaar:avg].
    const WEAV3R_ITEM_TTL_MS = 60 * 1000;
    const WEAV3R_ALL_TTL_MS = 60 * 1000;
    // Listings the crawler has not re-checked recently may already be sold; they are dropped
    // unless that would empty the list, in which case stale data beats no data.
    const WEAV3R_STALE_LISTING_MS = 30 * 60 * 1000;
    // A listing this far below the bazaar average is an outlier, not competition.
    const BAZAAR_SANITY_FLOOR_RATIO = 0.25;
    // How long a single weav3r call may hang before the row gives up and falls back to Torn.
    const WEAV3R_TIMEOUT_MS = 15 * 1000;
    // After weav3r itself is unreachable (network error, timeout, 5xx), further calls fail fast
    // for this long instead of each row waiting out the full timeout during a Fill All run.
    const WEAV3R_FAILURE_TTL_MS = 30 * 1000;
    // A Fill All run hits the same weav3r failure on every row; one notice a minute explains the
    // failed rows without burying the page in toasts.
    const WEAV3R_NOTICE_THROTTLE_MS = 60 * 1000;
    let weav3rItemCache = new Map();
    let weav3rAllCache = null;
    let weav3rFailure = null;
    let lastWeav3rNoticeTs = 0;
    // Bazaar page: the price a click on a price box fills in. Bazaars are priced against other
    // bazaars, so the default reads weav3r's bazaar listings rather than the item market.
    const isBazaarPage = /\/bazaar\.php/i.test(window.location.pathname);
    // Dollar bazaar mode: every bazaar fill lists at $1, with no price lookup. A toggle on the
    // Fill All bar switches it; it is remembered between visits.
    const DOLLAR_BAZAAR_KEY = "freaky-market-helper-dollar-bazaar";
    let dollarBazaar = isBazaarPage && localStorage.getItem(DOLLAR_BAZAAR_KEY) === '1';
    let bazaarDeltaRaw = localStorage.getItem("freaky-market-helper-bazaar-delta") ?? '-5[bazaar]';
    let priceDeltaRaw = localStorage.getItem("freaky-market-helper-price-delta") ?? localStorage.getItem("silmaril-torn-bazaar-filler-price-delta") ?? '-1[0]';
    // How many units to list per item: "max" (all of them), "max-N" (keep N back), a fixed
    // number, or "skip"/"0" to never list. Defaults to "max" — the behaviour before this existed.
    // Each page keeps its own preferences: quantity, category overrides, favourites, exclusions
    // and the receipt. The Item Market uses the original keys, so existing settings carry over.
    // A bazaar quantity that has never been saved starts from the Item Market value, and is
    // independent from the first Save on.
    const QUANTITY_KEY_MARKET = "freaky-market-helper-quantity-mode";
    const QUANTITY_KEY_BAZAAR = "freaky-market-helper-bazaar-quantity-mode";
    let quantityModeRaw = (isBazaarPage
        ? (localStorage.getItem(QUANTITY_KEY_BAZAAR) ?? localStorage.getItem(QUANTITY_KEY_MARKET))
        : localStorage.getItem(QUANTITY_KEY_MARKET)) ?? 'max';
    // Rounding of the final listed price: 0 leaves it exact, otherwise the price is rounded to
    // a multiple of that step ($10, $100, $1,000): the nearest one, always down, or always up.
    // Kept per page like the rest.
    const ROUNDING_KEY_MARKET = "freaky-market-helper-rounding";
    const ROUNDING_KEY_BAZAAR = "freaky-market-helper-bazaar-rounding";
    const ROUNDING_DIR_KEY_MARKET = "freaky-market-helper-rounding-dir";
    const ROUNDING_DIR_KEY_BAZAAR = "freaky-market-helper-bazaar-rounding-dir";
    const ROUNDING_STEPS = [0, 10, 100, 1000];
    const ROUNDING_DIRS = ['nearest', 'down', 'up'];
    function readRoundingDir(key){
        let value = localStorage.getItem(key);
        return ROUNDING_DIRS.indexOf(value) !== -1 ? value : 'nearest';
    }
    function readRounding(key){
        let value = parseInt(localStorage.getItem(key) ?? '0', 10);
        return ROUNDING_STEPS.indexOf(value) !== -1 ? value : 0;
    }
    let roundingStep = readRounding(isBazaarPage ? ROUNDING_KEY_BAZAAR : ROUNDING_KEY_MARKET);
    let roundingDir = readRoundingDir(isBazaarPage ? ROUNDING_DIR_KEY_BAZAAR : ROUNDING_DIR_KEY_MARKET);
    let apiKey = localStorage.getItem("freaky-market-helper-apikey") ?? '###PDA-APIKEY###';
    try {
        GM_registerMenuCommand('Open Settings', openSettingsModal);
        GM_registerMenuCommand("What's new", function(){ openChangelogModal(CHANGELOG); });
    } catch (error) {
        console.warn('[FreakyMarketHelper] Tampermonkey not detected!');
    }

    // Use the manager's GM_addStyle when it exists; Torn PDA has none, so fall back to a <style>.
    // (A differently named local avoids shadowing the granted function.)
    const addStyle = (typeof GM_addStyle === 'function') ? GM_addStyle : function (s) {
        let style = document.createElement("style");
        style.type = "text/css";
        style.innerHTML = s;
        document.head.appendChild(style);
    };
    addStyle(`
:root{--tmf-bg:#16181d;--tmf-bg2:#1e2128;--tmf-line:#2d313a;--tmf-text:#e8eaee;--tmf-dim:#8d93a0;--tmf-accent:#34d399;--tmf-accent-d:#059669;--tmf-warn:#fbbf24;--tmf-bad:#f87171;--tmf-radius:10px}
#item-market-root [class^=addListingWrapper___] [class^=panels___] [class^=priceInputWrapper___]>.input-money-group>.input-money,#item-market-root [class^=viewListingWrapper___] [class^=priceInputWrapper___]>.input-money-group>.input-money{font-size:smaller!important;border-bottom-left-radius:0!important;border-top-left-radius:0!important}
.fmh-button.input-money-symbol{display:inline-flex!important;align-items:center;justify-content:center;width:auto!important;min-width:46px;padding:0!important;background:none!important;border:0!important}
.fmh-button .fmh-btn{all:unset;box-sizing:border-box;cursor:pointer;min-width:46px;padding:0 10px;height:100%;min-height:26px;display:flex;align-items:center;justify-content:center;font:600 12px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.02em;color:#04281c;background:linear-gradient(180deg,#4ade9f,var(--tmf-accent-d));border-radius:6px 0 0 6px;transition:filter .15s,transform .05s}
.fmh-button .fmh-btn:hover{filter:brightness(1.12)}
.fmh-button .fmh-btn:active{transform:translateY(1px)}
.fmh-button.fmh-inline{display:inline-flex!important;vertical-align:middle;align-items:center;margin:0 6px;height:22px;width:auto!important;position:static}
.fmh-button.fmh-inline .fmh-btn{border-radius:6px;min-height:22px;height:22px;padding:0 10px}
.fmh-button.fmh-update .fmh-btn{color:#fff;background:linear-gradient(180deg,#60a5fa,#2563eb)}
.fmh-button[data-action-flag=clear] .fmh-btn{color:var(--tmf-text);background:linear-gradient(180deg,#4b5160,#363b47)}
.tmf-fav{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:22px;font-size:17px;line-height:1;color:#7b8190;align-self:center;margin-right:2px;user-select:none;-webkit-user-select:none;transition:transform .12s,color .12s}
.tmf-fav:hover{transform:scale(1.2);color:#aab}
.tmf-fav.tmf-fav--on{color:gold;text-shadow:0 0 6px rgba(255,215,0,.55)}
.tmf-fav.tmf-fav--off{color:var(--tmf-bad);text-shadow:none}
.tmf-select{cursor:pointer;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:20px;height:20px;margin:0 6px 0 2px;align-self:center;border:2px solid #7b8190;border-radius:5px;background:transparent;color:transparent;font-size:13px;font-weight:700;line-height:1;user-select:none;-webkit-user-select:none;transition:background .12s,border-color .12s,color .12s}
.tmf-select::after{content:"\\2713"}
.tmf-select:hover{border-color:var(--tmf-accent)}
.tmf-select.tmf-select--on{background:var(--tmf-accent-d);border-color:var(--tmf-accent);color:#fff}

/* Fill All bar */
.tmf-fillall-bar{position:fixed;bottom:110px;right:16px;width:204px;box-sizing:border-box;background:rgba(22,24,29,.96);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border:1px solid var(--tmf-line);border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.45);z-index:999999;touch-action:none;overflow:hidden;transition:box-shadow .2s ease,border-color .2s}
.tmf-fillall-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;color:#e6e9f0;font:700 12px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.02em;user-select:none;-webkit-user-select:none}
.tmf-fillall-title{flex:1 1 auto;white-space:nowrap}
.tmf-fillall-chev{flex:0 0 auto;color:#9aa1b0;font-size:10px;transition:transform .2s}
.tmf-fillall-bar--min .tmf-fillall-chev{transform:rotate(-90deg)}
.tmf-fillall-grip{cursor:grab;color:var(--tmf-dim);font-size:14px;line-height:1;letter-spacing:-2px;min-width:14px;text-align:center;user-select:none;-webkit-user-select:none}
.tmf-fillall-bar--dragging{cursor:grabbing;opacity:.92}
.tmf-fillall-bar--dragging .tmf-fillall-grip{cursor:grabbing}
.tmf-fillall-body{display:flex;flex-direction:column;gap:6px;padding:8px 8px 8px;border-top:1px solid var(--tmf-line)}
.tmf-fillall-cog,.tmf-fillall-report,.tmf-fillall-dollar{cursor:pointer;display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-radius:8px;background:rgba(255,255,255,.08);color:#dfe3ea;font:600 12px/1 -apple-system,Segoe UI,Roboto,sans-serif;user-select:none;-webkit-user-select:none;transition:background .15s,color .15s}
.tmf-fillall-cog:hover,.tmf-fillall-report:hover,.tmf-fillall-dollar:hover{background:rgba(255,255,255,.2);color:#fff}
.tmf-fillall-cog .tmf-cog-icon,.tmf-fillall-report .tmf-report-icon{font-size:14px;line-height:1;width:16px;text-align:center}
.tmf-fillall-report .tmf-report-label,.tmf-fillall-cog .tmf-cog-label{flex:1 1 auto}
.tmf-fillall-dollar.tmf-fillall-dollar--on{background:var(--tmf-warn);color:#2a1d00;box-shadow:0 0 8px rgba(251,191,36,.55)}
.tmf-report-count:empty{display:none}
.tmf-report-count{background:var(--tmf-accent-d);color:#fff;border-radius:999px;padding:2px 6px;font-size:11px}
.tmf-fillall-btn.torn-btn{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;text-align:center;padding:9px 14px;border-radius:8px;font:700 13px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.03em;color:#04281c;background:linear-gradient(180deg,#4ade9f,var(--tmf-accent-d));transition:filter .15s}
.tmf-fillall-btn.torn-btn:hover{filter:brightness(1.12)}
.tmf-fillall-bar--active .tmf-fillall-btn.torn-btn{color:#fff;background:linear-gradient(180deg,#f87171,#b91c1c)}
.tmf-quick-toggle{cursor:pointer;display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-radius:8px;background:rgba(255,255,255,.08);color:#dfe3ea;font:600 12px/1 -apple-system,Segoe UI,Roboto,sans-serif;user-select:none;-webkit-user-select:none}
.tmf-quick-toggle:hover{background:rgba(255,255,255,.2);color:#fff}
.tmf-quick-toggle .tmf-quick-label{flex:1 1 auto}
.tmf-quick-toggle .tmf-quick-arrow{font-size:10px;color:#9aa1b0;transition:transform .2s}
.tmf-quick--open .tmf-quick-arrow{transform:rotate(180deg)}
.tmf-quick-panel{display:none;flex-direction:column;gap:5px;padding:8px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid var(--tmf-line)}
.tmf-quick--open .tmf-quick-panel{display:flex}
.tmf-quick-panel label{color:#9aa1b0;font:600 10px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.06em;text-transform:uppercase;margin-top:3px}
.tmf-quick-panel input[type=text],.tmf-quick-panel select{width:100%;box-sizing:border-box;padding:5px 7px;border-radius:6px;border:1px solid var(--tmf-line);background:#0d0f13;color:var(--tmf-text);font:12px ui-monospace,Menlo,Consolas,monospace}
.tmf-quick-panel input[type=text]:focus,.tmf-quick-panel select:focus{outline:0;border-color:var(--tmf-accent)}
.tmf-quick-panel input.tmf-quick-bad{border-color:var(--tmf-bad)}
.tmf-quick-row{display:flex;gap:5px}
.tmf-quick-row>input,.tmf-quick-row>select{flex:1 1 auto;min-width:0}
.tmf-quick-btn{cursor:pointer;flex:0 0 auto;padding:0 9px;border-radius:6px;border:1px solid var(--tmf-line);background:rgba(255,255,255,.08);color:#dfe3ea;font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif}
.tmf-quick-btn:hover:not(:disabled){background:rgba(255,255,255,.2);color:#fff}
.tmf-quick-btn:disabled{opacity:.35;cursor:default}
.tmf-quick-btn.tmf-quick-save{background:var(--tmf-accent-d);border-color:var(--tmf-accent-d);color:#fff}
.tmf-quick-note{font:11px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--tmf-dim);min-height:14px}
.tmf-quick-note.tmf-bad{color:var(--tmf-bad)}
.tmf-quick-note.tmf-ok{color:var(--tmf-accent)}
.tmf-fillall-bar--min{width:auto}
.tmf-fillall-bar--min .tmf-fillall-body{display:none}
.tmf-autofill-dot{display:none;width:9px;height:9px;border-radius:50%;background:var(--tmf-accent);box-shadow:0 0 6px var(--tmf-accent);animation:tmfPulse 1s ease-in-out infinite}
.tmf-fillall-bar--active .tmf-autofill-dot{display:inline-block}
.tmf-fillall-bar--active{border-color:var(--tmf-accent);box-shadow:0 0 14px 2px rgba(52,211,153,.45)}
@keyframes tmfPulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}
.tmf-viewport-border{display:none;position:fixed;inset:0;border:2px solid var(--tmf-accent);box-shadow:inset 0 0 14px rgba(52,211,153,.4);pointer-events:none;z-index:999998}
.tmf-viewport-border--active{display:block}
.tmf-toast{position:fixed;bottom:158px;right:16px;max-width:300px;background:var(--tmf-bg);color:var(--tmf-text);padding:10px 14px;border-radius:8px;border:1px solid var(--tmf-line);border-left:3px solid var(--tmf-warn);font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);z-index:1000000;opacity:0;visibility:hidden;transform:translateY(6px);transition:opacity .25s,visibility .25s,transform .25s}
.tmf-toast--visible{opacity:1;visibility:visible;transform:none}
`);

    addStyle(`
.tmf-modal-overlay{display:none;position:fixed;inset:0;background:rgba(5,7,10,.7);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:2147483000;justify-content:center;align-items:flex-start;overflow:auto;padding:24px 12px;box-sizing:border-box}
.tmf-modal-overlay--open{display:flex}
.tmf-modal{background:var(--tmf-bg);color:var(--tmf-text);width:100%;max-width:460px;border:1px solid var(--tmf-line);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);padding:18px 20px;box-sizing:border-box;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.tmf-modal h3{margin:0 0 4px;font-size:16px;display:flex;justify-content:space-between;align-items:center;color:#fff}
.tmf-modal-sub{margin:0 0 6px;color:var(--tmf-dim);font-size:12px}
.tmf-modal-close{cursor:pointer;color:var(--tmf-dim);font-size:24px;line-height:1}
.tmf-modal-close:hover{color:#fff}
.tmf-modal-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--tmf-line)}
.tmf-modal-section:first-of-type{border-top:0;padding-top:0;margin-top:10px}
.tmf-modal-section>h4{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--tmf-dim);font-weight:700}
.tmf-modal label{display:block;margin:10px 0 4px;font-weight:600;color:#cfd3dc}
.tmf-modal input[type=text],.tmf-modal input[type=password]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:7px;border:1px solid var(--tmf-line);background:#0d0f13;color:var(--tmf-text);font:13px ui-monospace,Menlo,Consolas,monospace;transition:border-color .15s,box-shadow .15s}
.tmf-modal select.tmf-modal-round,.tmf-modal select.tmf-modal-round-dir{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:7px;border:1px solid var(--tmf-line);background:#0d0f13;color:var(--tmf-text);font:13px ui-monospace,Menlo,Consolas,monospace}
.tmf-modal select.tmf-modal-round:focus,.tmf-modal select.tmf-modal-round-dir:focus{outline:0;border-color:var(--tmf-accent);box-shadow:0 0 0 3px rgba(52,211,153,.18)}
.tmf-modal input[type=text]:focus,.tmf-modal input[type=password]:focus{outline:0;border-color:var(--tmf-accent);box-shadow:0 0 0 3px rgba(52,211,153,.18)}
.tmf-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.tmf-chip{cursor:pointer;border:1px solid var(--tmf-line);background:var(--tmf-bg2);color:#cfd3dc;border-radius:999px;padding:4px 10px;font-size:11px;line-height:1.3;transition:border-color .15s,background .15s}
.tmf-chip:hover{border-color:var(--tmf-accent);background:rgba(52,211,153,.1);color:#fff}
.tmf-modal-live{min-height:18px;margin-top:5px;font-size:11px;color:var(--tmf-dim)}
.tmf-modal-live.tmf-ok{color:var(--tmf-accent)}
.tmf-modal-live.tmf-bad{color:var(--tmf-bad)}
.tmf-modal-key{position:relative;display:flex;align-items:center}
.tmf-modal-key input[type=text],.tmf-modal-key input[type=password]{padding-right:56px}
.tmf-modal-key-reveal{position:absolute;right:8px;cursor:pointer;color:var(--tmf-dim);font-size:11px;padding:3px 4px;user-select:none;-webkit-user-select:none}
.tmf-modal-key-reveal:hover{color:#fff}
.tmf-modal-toggle{display:flex;align-items:center;gap:8px;margin-top:10px;font-weight:600;color:#cfd3dc;cursor:pointer}
.tmf-modal-toggle input{width:auto;accent-color:var(--tmf-accent)}
.tmf-modal-cats{margin-top:4px}
.tmf-modal-cat-row{display:flex;gap:6px;margin-bottom:6px;align-items:center}
.tmf-modal-cat-row input{min-width:0}
.tmf-modal-cat-row .tmf-modal-cat-name{flex:1 1 36%}
.tmf-modal-cat-row .tmf-modal-cat-formula{flex:1 1 34%}
.tmf-modal-cat-row .tmf-modal-cat-qty{flex:1 1 30%}
.tmf-modal-cat-head{display:flex;gap:6px;margin:0 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--tmf-dim)}
.tmf-modal-cat-head span:nth-child(1){flex:1 1 36%}
.tmf-modal-cat-head span:nth-child(2){flex:1 1 34%}
.tmf-modal-cat-head span:nth-child(3){flex:1 1 30%}
.tmf-modal-cat-head span:nth-child(4){flex:0 0 22px}
.tmf-modal-cat-del{cursor:pointer;color:var(--tmf-bad);font-size:20px;line-height:1;flex:0 0 auto;width:22px;text-align:center}
.tmf-modal-addcat,.tmf-modal-resetcat,.tmf-modal-clearexcl{cursor:pointer;background:var(--tmf-bg2);color:#cfd3dc;border:1px solid var(--tmf-line);border-radius:7px;padding:6px 11px;font-size:12px;margin:2px 6px 0 0}
.tmf-modal-addcat:hover,.tmf-modal-resetcat:hover,.tmf-modal-clearexcl:hover{border-color:var(--tmf-accent);color:#fff}
.tmf-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
.tmf-modal-actions button{cursor:pointer;padding:8px 18px;border-radius:8px;border:1px solid var(--tmf-line);background:var(--tmf-bg2);color:var(--tmf-text);font-size:13px;font-weight:600}
.tmf-modal-actions button:hover{border-color:#555b68}
.tmf-modal-save{background:linear-gradient(180deg,#4ade9f,var(--tmf-accent-d))!important;border-color:transparent!important;color:#04281c!important}
.tmf-modal-help{margin-top:12px;font-size:11px;color:var(--tmf-dim);line-height:1.6}
.tmf-modal-help summary{cursor:pointer;color:#cfd3dc;font-weight:600;font-size:12px}
.tmf-modal-help code{background:#000;padding:1px 5px;border-radius:4px;color:#9ef0c8}
.tmf-modal-help p{margin:6px 0}
.tmf-modal-error{display:none;margin-top:12px;padding:8px 10px;border-radius:7px;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.5);color:#fecaca;font-size:12px;line-height:1.4}
.tmf-tabs{display:flex;gap:4px;margin:8px 0 6px;padding:3px;background:var(--tmf-bg2);border:1px solid var(--tmf-line);border-radius:9px}
.tmf-tab{flex:1;text-align:center;cursor:pointer;padding:6px 8px;border-radius:7px;font-weight:600;color:var(--tmf-dim);user-select:none;-webkit-user-select:none;transition:background .15s,color .15s}
.tmf-tab:hover{color:#fff}
.tmf-tab.tmf-tab--on{background:linear-gradient(180deg,#4ade9f,var(--tmf-accent-d));color:#04281c}
.tmf-modal--bazaar .tmf-modal-cat-formula,.tmf-modal--bazaar .tmf-modal-resetcat{display:none}
.tmf-modal--bazaar .tmf-modal-cat-head span:nth-child(2){display:none}
.tmf-modal--bazaar .tmf-modal-cat-row .tmf-modal-cat-name{flex:1 1 55%}
.tmf-modal--bazaar .tmf-modal-cat-row .tmf-modal-cat-qty{flex:1 1 45%}
.tmf-modal--bazaar .tmf-modal-cat-head span:nth-child(1){flex:1 1 55%}
.tmf-modal--bazaar .tmf-modal-cat-head span:nth-child(3){flex:1 1 45%}
.tmf-receipt{font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#0d0f13;border:1px solid var(--tmf-line);border-radius:8px;padding:12px 14px;margin-top:10px}
.tmf-receipt-empty{color:var(--tmf-dim);text-align:center;padding:14px 0;font-family:inherit}
.tmf-receipt-line{display:flex;justify-content:space-between;gap:10px}
.tmf-receipt-line .tmf-rname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmf-receipt-line .tmf-rsub{color:var(--tmf-dim)}
.tmf-receipt-rule{border:0;border-top:1px dashed var(--tmf-line);margin:8px 0}
.tmf-receipt-total{font-weight:700;color:#fff}
.tmf-receipt-gain{color:var(--tmf-accent);font-weight:700}
.tmf-receipt-loss{color:var(--tmf-bad);font-weight:700}
.tmf-receipt-note{margin-top:8px;font:11px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--tmf-dim)}
.tmf-modal input.tmf-modal-invalid{border-color:var(--tmf-bad)!important;box-shadow:0 0 0 3px rgba(248,113,113,.18)!important}
`);

    addStyle(`.tmf-changelog-release{margin:0 0 14px}.tmf-changelog-release:last-of-type{margin-bottom:0}.tmf-changelog-ver{display:flex;align-items:baseline;gap:8px;margin:0 0 6px}.tmf-changelog-ver b{color:#fff;font-size:13px}.tmf-changelog-date{color:#8a8a8a;font-size:11px;margin-left:auto}.tmf-changelog-badge{background:#2e7d32;color:#fff;border-radius:10px;padding:1px 7px;font-size:10px;text-transform:uppercase;letter-spacing:.04em}.tmf-changelog-items{margin:0;padding-left:18px;color:#cfcfcf}.tmf-changelog-items li{margin:0 0 5px}.tmf-changelog-items code{background:#000;padding:1px 4px;border-radius:3px;color:#cfc}`);

    const lastSeenVersionKey = "freaky-market-helper-last-seen-version";
    // Newest release first. Everything a user could have skipped over is listed, so updating
    // across several versions still shows the whole gap in one popup. A release marked
    // `silent: true` is left out of that and never opens the popup by itself; it is listed
    // only when the popup is opened from the menu. Leaving the flag off means false.
    // Write every line for a player, not a developer: one short sentence, plain words,
    // what changed for them rather than what changed in the code.
    const CHANGELOG = [
        {
            version: "1.6.6",
            date: "2026-10-20",
            changes: [
                'The Fill All bar is now a small drop-down panel. Click its title to open or close it. Open, it lists Fill All, Session receipt, Settings and (on the Bazaar) Dollar bazaar as labelled rows. You can still drag it by the title.',
                'New "Quick changes" section in the panel: switch your price formula, quantity and rounding right there, with presets, without opening Settings. It saves as you change it.',
                'You can save your own presets: type a name and press Save in Quick changes. A custom preset remembers the formula, quantity and rounding together. Item Market and Bazaar keep their own lists.',
                'New "Round direction" setting: round to the nearest, always down (so you undercut), or always up (so you never list below the number).'
            ]
        },
        {
            version: "1.6.5",
            date: "2026-10-20",
            changes: [
                'New "Round listed price" setting: round every listing to the nearest $10, $100 or $1,000, or leave it exact. Item Market and Bazaar each keep their own choice.'
            ]
        },
        {
            version: "1.6.4",
            date: "2026-10-20",
            changes: [
                'On the Bazaar Manage page the Update button now sits in the Details column of each listing. The favourite star stays beside the item name.'
            ]
        },
        {
            version: "1.6.3",
            date: "2026-10-20",
            changes: [
                'Removed the message that popped up after every fill ("$12,939 = 2%[market] on market value..."). Errors still show a message.',
                'On the Bazaar Manage page the Update button now sits right after each item name, so it no longer crowds the price box off the edge of the screen.'
            ]
        },
        {
            version: "1.6.2",
            date: "2026-10-20",
            changes: [
                'Fixed: the Update button did not show up on the Bazaar Manage page. It now sits next to each active listing and re-prices it with your Bazaar setting.',
                'Fixed: item names on the bazaar receipt no longer start with the "x3" count.'
            ]
        },
        {
            version: "1.6.1",
            date: "2026-10-20",
            changes: [
                'On the Bazaar Manage page each listing now has a blue <code>Update</code> button. Click it to re-price that listing with your Bazaar setting, as often as you like. It never flips to Clear.',
                'Update only sets the price box. Confirm the change with Torn\'s own save button as usual.'
            ]
        },
        {
            version: "1.6.0",
            date: "2026-10-20",
            changes: [
                'Renamed to Freaky Market Helper. Your settings, favourites and receipt carry over automatically.'
            ]
        },
        {
            version: "1.5.0",
            date: "2026-10-20",
            changes: [
                'New: dollar bazaar mode. On the Bazaar pages the Fill All bar has a <code>$1</code> button. Turn it on and every Fill, tick or Fill All lists the item for $1, with no price lookup and no API key needed.',
                'The amount still follows your Bazaar quantity setting. Turn the button off to go back to normal pricing.'
            ]
        },
        {
            version: "1.4.1",
            date: "2026-10-20",
            changes: [
                'The Bazaar Manage page now has the Fill button, select box and favourite star on each row too, using your Bazaar settings. Fill All works there as well.',
                'Re-pricing a listing on Manage does not add to the session receipt, since that only tracks items you add.'
            ]
        },
        {
            version: "1.4.0",
            date: "2026-10-20",
            changes: [
                'The Item Market and the Bazaar now keep separate settings. Settings has a tab for each, so a price, quantity or category rule saved on one no longer changes the other.',
                'Favourites, excluded items and the session receipt are separate for each page too.',
                'Your existing Item Market settings carry over untouched. The Bazaar starts from your current quantity until you save its tab.'
            ]
        },
        {
            version: "1.3.0",
            date: "2026-10-20",
            changes: [
                'New: the Bazaar Add Items page now has the same tools as the Item Market. Each row gets a Fill button, a select box and a favourite star, and the Fill All bar and the session receipt work there too.',
                'Bazaar rows are priced with your Bazaar page setting (<code>-5[bazaar]</code> by default). Bazaar sales carry no tax, so the receipt shows them untaxed.'
            ]
        },
        {
            version: "1.2.0",
            date: "2026-10-20",
            changes: [
                'New: the Bazaar page. Click a price box and it fills in the price, like the old Bazaar Auto Price script. Click an amount box and it fills in how many you own.',
                'The bazaar price is its own setting, <code>-5[bazaar]</code> by default (cheapest bazaar minus $5). Change it in settings; it takes the same formulas as everywhere else.',
                'The amount follows your quantity setting, so <code>max-1</code> keeps one back here too.'
            ]
        },
        {
            version: "1.1.5",
            date: "2026-10-20",
            silent: true,
            changes: [
                'Minor updates now arrive quietly: they are listed here, but no longer open this popup on their own.'
            ]
        },
        {
            version: "1.1.0",
            date: "2026-09-21",
            changes: [
                'New: price ranges. Put <code>min()</code> and <code>max()</code> inside each other to keep a price between a floor and a ceiling.',
                '<code>min(max(-1[0], +10%[market]), -1[14])</code> undercuts the cheapest listing, but never goes below 10% over market value, and never above the 15th listing &minus; $1.',
                'Handy when a big stack would otherwise make you the cheapest seller and you would rather sit further down the list.'
            ]
        },
        {
            version: "1.0.0",
            date: "2026-09-07",
            changes: [
                'New: combine price sources. Write <code>-1[bazaar] | -1[0]</code> and both are priced, then the higher one is filled. Use it to put a floor under a source that sometimes goes cheap.',
                'The same thing spelled out is <code>max(-1[bazaar], -1[0])</code>. Use <code>min(-1[bazaar], -1[0])</code> instead to fill the lower one and undercut whichever source is cheapest.',
                'Settings now checks what you type. A price or quantity it cannot use is refused with a note saying which field is wrong and why, instead of being saved and failing on every item later.'
            ]
        },
        {
            version: "0.13.3",
            date: "2026-09-07",
            changes: [
                'Fixed: the <code>[bazaar]</code> prices never worked at all. They do now.',
                'Your userscript manager may ask for a new permission on this update. Say yes, or bazaar prices stay broken.',
                'If you only use bazaar prices, the script no longer asks for a Torn API key it does not need.',
                'A bazaar price that cannot be fetched now tells you why, instead of failing quietly.'
            ]
        },
        {
            version: "0.13.0",
            date: "2026-09-02",
            changes: [
                'New: see what items go for in player bazaars, not just the item market. Put <code>[bazaar]</code> in your price setting for the cheapest bazaar listing. No API key needed.',
                'Also <code>[bazaar:2]</code> for the 3rd cheapest, <code>[bazaar:avg]</code> for the average and <code>[bazaar:median]</code> for the middle price.',
                'Useful for spotting when the item market has drifted away from what an item really sells for.',
                'Sponsored, stale and silly-cheap listings are ignored, so one troll price cannot drag Fill All down.',
                'The prices popup lists bazaar listings too, so you can see what you are pricing against.',
                'An item with no bazaar price falls back to the item market instead of failing.',
                'Fixed: a price with no discount, such as <code>[market]</code> on its own, no longer errors.',
                'New: this popup. After an update it lists what changed, then stays quiet until the next one.'
            ]
        }
    ];

    const pages = { "AddItems": 10, "ViewItems": 20, "Other": 0};

    // Favourites are deliberately stored under a market-filler-specific key,
    // separate from the bazaar-filler favourites list.
    const favouritesStorageKey = isBazaarPage ? "freaky-market-helper-bazaar-favourites" : "freaky-market-helper-favourites";
    let favourites = loadFavourites();

    // Session receipt ledger (see "Session receipt" below). Declared up here because the Fill All
    // bar is built before that section is reached.
    const sessionKey = isBazaarPage ? "freaky-market-helper-bazaar-session" : "freaky-market-helper-session";
    let session = loadSession();

    // Excluded items are never touched by Fill All, and a manual Fill on one warns first.
    // An item is either neutral, a favourite or excluded — never two of those at once.
    const excludedStorageKey = isBazaarPage ? "freaky-market-helper-bazaar-excluded" : "freaky-market-helper-excluded";
    let excluded = loadExcluded();

    // Per-category price-delta overrides + a persistent item→category(type) cache.
    // Item categories are immutable, so caching them avoids extra API calls when picking
    // which price source a category's formula needs.
    const categoryDeltasKey = "freaky-market-helper-category-deltas";
    // Per-category quantity overrides live in their own map so the existing delta entries keep
    // their shape (a bare formula string) and upgrade without migration.
    const CATEGORY_QUANTITIES_KEY_MARKET = "freaky-market-helper-category-quantities";
    const CATEGORY_QUANTITIES_KEY_BAZAAR = "freaky-market-helper-bazaar-category-quantities";
    const categoryQuantitiesKey = isBazaarPage ? CATEGORY_QUANTITIES_KEY_BAZAAR : CATEGORY_QUANTITIES_KEY_MARKET;
    const itemCategoryCacheKey = "freaky-market-helper-item-categories";
    // Item types are mostly immutable but Torn occasionally recategorises an item, so cached
    // categories are re-verified from each response and forcibly refreshed once past this TTL.
    const CATEGORY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
    const SETTINGS_CATEGORIES = ["Melee","Primary","Secondary","Defensive","Temporary","Drug","Medical","Booster","Energy Drink","Alcohol","Candy","Enhancer","Clothing","Jewelry","Material","Flower","Plushie","Car","Supply Pack","Special","Collectible","Artifact","Tool","Other"];
    let categoryDeltas = loadCategoryDeltas();
    let categoryQuantities = loadCategoryQuantities();
    let itemCategoryCache = loadItemCategoryCache();

    // "Fill All" auto-fill mode state. One activation fills each favourite item once;
    // rows appearing later (category/tab switches) are picked up by the mutation observer.
    const FILL_COOLDOWN_MIN_MS = 600;
    const FILL_COOLDOWN_MAX_MS = 1000;
    const RATE_LIMIT_PAUSE_MIN_MS = 3000;
    const RATE_LIMIT_PAUSE_MAX_MS = 10000;
    // A row that is still rate-limited after this many pauses is given up on, so one stubborn
    // item cannot hold the whole run (and the API) hostage.
    const MAX_RATE_LIMIT_RETRIES = 5;
    let autoFillActive = false;
    let autoFillLoopRunning = false;
    let autoFillQueue = [];
    let autoFillQueuedIds = new Set();
    let autoFillDoneIds = new Set();
    let autoFillRetries = new Map();
    let toastTimer = null;
    // Set once Torn's chat z-index is detected, so our floating UI sits just below the
    // chat (an open chat window covers it instead of the button overshadowing the chat).
    let chatRelativeZBase = null;
    let chatZRetries = 0;
    const CHAT_Z_MAX_RETRIES = 20;

    // Draggable / minimisable Fill All bar. Position + minimised state persist across visits.
    const fillAllStateKey = "freaky-market-helper-fillall-pos";
    const FILLALL_EDGE_SNAP_PX = 40;       // drop within this of an edge → clamp + minimise
    const FILLALL_DRAG_THRESHOLD_PX = 6;   // movement before a press counts as a drag
    const FILLALL_VIEWPORT_MARGIN_PX = 4;  // keep this gap from the edge when not snapped
    let fillAllState = loadFillAllState();

    // The 5% fee is an Item Market fee. A bazaar sale is assumed to carry none, so the receipt and
    // the fill toast take nothing off on the bazaar pages.
    const BAZAAR_TAX = 0;
    const marketTaxFactor = isBazaarPage ? 1 - BAZAAR_TAX : 1 - getCurrentMarketTax();
    let currentPage = pages.Other;
    let holdTimer;
    // Set when a press-and-hold has opened the settings, so the click that follows the release
    // is swallowed instead of also filling the row.
    let holdFired = false;
    // Falling back to the body keeps the scan and the observer alive if the root is renamed
    // or has not mounted yet; the row selectors below are specific enough to stay correct.
    const observerTarget = document.querySelector("#item-market-root") ?? document.querySelector("#bazaarRoot") ?? document.body;
    const observerConfig = { attributes: false, childList: true, characterData: false, subtree: true };

    // Debounced whole-root scan instead of matching specific mutation targets: rows on the
    // Add Items and Your Items (view listings) pages mount at different depths (tab panels,
    // list containers, pagination), and target-based matching silently missed the latter.
    // AddFillButton is idempotent, so re-scanning already-processed rows is cheap.
    let scanScheduled = false;
    function scanAndInject() {
        scanScheduled = false;
        currentPage = getCurrentPage();
        if (currentPage == pages.Other) {
            return;
        }
        if (isBazaarPage){
            scanBazaarRows(observerTarget);
        } else {
            observerTarget.querySelectorAll('[class*=itemRowWrapper___] > [class*=itemRow___]:not([class*=grayedOut___]) [class^=priceInputWrapper___]').forEach(x => AddFillButton(x));
        }
        if (autoFillActive) {
            enqueueVisibleFavourites();
        }
    }

    function scheduleScan() {
        if (!scanScheduled) {
            scanScheduled = true;
            requestAnimationFrame(scanAndInject);
        }
    }

    const observer = new MutationObserver(function(mutations) {
        for (const m of mutations) {
            if (m.addedNodes.length || m.removedNodes.length) {
                scheduleScan();
                return;
            }
        }
    });
    observer.observe(observerTarget, observerConfig);
    // Tab switches (#/addListing ↔ #/viewListing) don't always leave rows unprocessed,
    // but a scan on hashchange is cheap insurance against missed mutations.
    window.addEventListener("hashchange", scheduleScan);
    ensureFillAllUI();
    // Rows may already be in the DOM at script start (run-at: document-idle).
    scheduleScan();
    if (isBazaarPage) {
        initBazaarAutoPrice();
    }

    // Tell the user what an update changed, the first time they land on the market after it.
    maybeShowChangelog();

    // Keep the Fill All bar on-screen (and flush to its edge if minimised) after a resize/rotate.
    window.addEventListener("resize", function() {
        let bar = document.querySelector(".tmf-fillall-bar");
        if (bar != null && fillAllState != null) {
            applyFillAllState(bar);
        }
    });

    function AddFillButton(itemPriceElement){
        const wrapperParent = findRowWrapper(itemPriceElement);
        if (wrapperParent == null){
            return;
        }
        let existingButton = wrapperParent.querySelector('.fmh-button');
        if (existingButton != null){
            // React may reuse this row's DOM for a different item (pagination, tab switches),
            // so the id the button was injected with can go stale.
            refreshRowItemId(wrapperParent);
            let existing = existingButton;
            setActionFlag(existing, existing.getAttribute('data-action-flag') ?? 'fill');
            return;
        }
        wrapperParent.classList.add('fmh-processed');
        let itemId = getRowItemId(wrapperParent);
        // Bazaar Manage: the price column is too narrow for a button, so the Update button goes in
        // the row's Details column (the name cell if there is none) and the star after the name.
        const manageRow = isBazaarPage && currentPage == pages.ViewItems;
        const descHost = manageRow ? wrapperParent.querySelector('[class*=desc___]') : null;
        const detailsHost = manageRow ? (wrapperParent.querySelector('[class*=bonuses___]') ?? descHost) : null;
        const span = document.createElement('span');
        span.className = detailsHost != null ? 'fmh-button fmh-inline' : 'fmh-button input-money-symbol';
        if (detailsHost == null){
            span.style.position = "relative";
        }
        span.setAttribute('data-action-flag', 'fill');
        span.addEventListener('click', async function(e) {
            if (holdFired){
                holdFired = false;
                return;
            }
            // Resolved at click time rather than captured at injection, so a reused row
            // always prices the item it is showing now.
            let currentId = getRowItemId(wrapperParent);
            await handleFillClick(e, currentId > 0 ? currentId : itemId);
        });
        span.addEventListener('mousedown', startHold);
        span.addEventListener('touchstart', startHold);
        span.addEventListener('mouseup', cancelHold);
        span.addEventListener('mouseleave', cancelHold);
        span.addEventListener('touchend', cancelHold);
        span.addEventListener('touchcancel', cancelHold);
        const input = document.createElement('input');
        input.type = 'button';
        input.className = 'fmh-btn';
        input.value = 'Fill';
        span.appendChild(input);

        const moneyGroup = itemPriceElement.querySelector('.input-money-group');
        const itemIdNum = parseInt(itemId, 10);
        if (!isNaN(itemIdNum) && itemIdNum > 0){
            wrapperParent.dataset.tmfItemId = itemIdNum;
            // First slot of the row's controls container — left of the anonymous button.
            const infoContainer = findInfoRow(itemPriceElement);
            const favHost = descHost ?? (isBazaarPage ? (moneyGroup.parentElement ?? moneyGroup) : (infoContainer ?? moneyGroup));
            // A re-render can remount the price wrapper while the row (and our star) survives;
            // guard against stacking a second star on re-scan.
            if (favHost.querySelector('.tmf-fav') == null){
                const favBtn = document.createElement('span');
                favBtn.className = 'tmf-fav';
                renderFavIcon(favBtn, getItemState(itemIdNum));
                favBtn.dataset.tmfItemId = itemIdNum;
                favBtn.addEventListener('click', function(e){
                    e.preventDefault();
                    e.stopPropagation();
                    // Read from the element, since refreshRowItemId may have retargeted it.
                    let currentId = parseInt(favBtn.dataset.tmfItemId, 10);
                    cycleItemState(currentId);
                    if (autoFillActive && favourites.has(currentId)){
                        enqueueFavouriteRow(wrapperParent);
                    }
                });
                if (descHost != null){
                    descHost.append(favBtn);
                } else {
                    favHost.prepend(favBtn);
                }
            }
            // Select box (Add Items only): tick it to price and fill the row, untick to clear it.
            if (currentPage == pages.AddItems && favHost.querySelector('.tmf-select') == null){
                const selectBox = document.createElement('span');
                selectBox.className = 'tmf-select';
                selectBox.title = 'Select this item: prices it and fills the quantity. Click again to clear.';
                selectBox.addEventListener('click', async function(e){
                    e.preventDefault();
                    e.stopPropagation();
                    let currentId = getRowItemId(wrapperParent);
                    await triggerFill(span, currentId > 0 ? currentId : itemId);
                });
                favHost.prepend(selectBox);
            }
            placeFillButton(span, detailsHost, moneyGroup);
            if (autoFillActive){
                enqueueFavouriteRow(wrapperParent);
            }
        } else {
            placeFillButton(span, detailsHost, moneyGroup);
        }
    }

    // Next to the item name (before the star) when there is a name cell to use, else inside the price box.
    function placeFillButton(span, descHost, moneyGroup){
        if (descHost != null){
            let star = descHost.querySelector('.tmf-fav');
            if (star != null){
                descHost.insertBefore(span, star);
            } else {
                descHost.append(span);
            }
        } else {
            moneyGroup.prepend(span);
        }
    }

    // Re-read a row's item id and, if the row now shows a different item, retarget its star and
    // reset its Fill button (the old fill state described another item).
    function refreshRowItemId(wrapperParent){
        let id = getRowItemId(wrapperParent);
        if (!(id > 0) || parseInt(wrapperParent.dataset.tmfItemId, 10) === id){
            return;
        }
        wrapperParent.dataset.tmfItemId = id;
        wrapperParent.querySelectorAll('.tmf-fav').forEach(function(el){
            el.dataset.tmfItemId = id;
            renderFavIcon(el, getItemState(id));
        });
        let fillBtn = wrapperParent.querySelector('.fmh-button');
        if (fillBtn != null){
            setActionFlag(fillBtn, 'fill');
        }
        if (autoFillActive){
            enqueueFavouriteRow(wrapperParent);
        }
    }

    // Resolve a row's item id from whichever source the page provides: the info button's
    // aria-controls id on Add Items rows, otherwise any item image in the row. The Your Items
    // (view listings) rows don't reliably carry the aria-controls id, and dereferencing the
    // missing button used to throw — killing button injection for the whole row.
    // Always returns a number (or -1): a string id here would make Map keys and `===` checks
    // disagree with the numeric ids used everywhere else.
    function getRowItemId(wrapperParent){
        if (currentPage == pages.AddItems){
            let infoButton = wrapperParent.querySelector('[class^=itemRow___] [type=button][class^=viewInfoButton___]');
            let ariaControls = infoButton != null ? infoButton.getAttribute('aria-controls') : null;
            if (ariaControls != null){
                let itemId = parseInt(getItemIdFromString(ariaControls), 10);
                if (itemId > 0){
                    return itemId;
                }
            }
        }
        let itemImage = wrapperParent.querySelector('[class*=viewInfoButton] img')
            ?? wrapperParent.querySelector('img[src*="/items/"]');
        if (itemImage != null){
            return getItemIdFromImage(itemImage);
        }
        console.error("[FreakyMarketHelper] ItemId not found!");
        return -1;
    }

    // ---- Price sources ---------------------------------------------------------------------
    // A formula names its source inside its bracket: no bracket or [n] is Torn's item market,
    // [market] is Torn's market value, [bazaar...] is weav3r's player-bazaar data.

    function bracketToken(formula){
        let open = formula.indexOf('[');
        if (open == -1){
            return '';
        }
        let close = formula.indexOf(']', open);
        return (close == -1 ? formula.substring(open + 1) : formula.substring(open + 1, close)).trim().toLowerCase();
    }

    function stripDeltaBracket(formula){
        // Trimmed, because Save accepts "-1 [0]" and the delta parser does not allow the space.
        return formula.indexOf('[') == -1 ? formula : formula.substring(0, formula.indexOf('[')).trim();
    }

    // The index of the ) that closes the ( at `open`, or -1 when nothing does.
    function matchingParen(text, open){
        let depth = 0;
        for (let i = open; i < text.length; i++){
            if (text.charAt(i) === '('){
                depth++;
            } else if (text.charAt(i) === ')'){
                depth--;
                if (depth === 0){
                    return i;
                }
            }
        }
        return -1;
    }

    // Split on the separators that belong to this level only: the ones inside a nested
    // min(...)/max(...) belong to that call, not to us.
    function splitTopLevel(body){
        let parts = [];
        let depth = 0;
        let current = '';
        for (let i = 0; i < body.length; i++){
            let ch = body.charAt(i);
            if (ch === '('){
                depth++;
            } else if (ch === ')'){
                depth--;
            } else if ((ch === '|' || ch === ',') && depth <= 0){
                parts.push(current);
                current = '';
                continue;
            }
            current += ch;
        }
        parts.push(current);
        return parts;
    }

    // A setting parses into a tree. A leaf is one formula, {kind:'formula'}; min(...) and
    // max(...) are {kind:'combine'} nodes over the formulas — or over further calls — inside
    // them. "a | b" and "max(a, b)" both mean the highest of a and b; "min(a, b)" means the
    // lowest, to undercut whichever source is cheapest. Calls nest, so a price can be held
    // inside a band: min(max(a, b), c) is never below b and never above c.
    // Nothing here throws on a formula it cannot make sense of — a setting saved before Save
    // started validating them still parses, as the one leaf it will later fail to price.
    function parseSetting(setting){
        return parseExpression(String(setting ?? '').trim(), 'max');
    }

    // One level: the terms between this level's separators, combined by `combine`. A single
    // term needs no node of its own, since the highest — or lowest — of one thing is itself.
    function parseExpression(body, combine){
        let terms = splitTopLevel(body).map(function(term){ return term.trim(); })
            .filter(function(term){ return term !== ''; });
        if (terms.length === 0){
            terms = [body.trim()];
        }
        if (terms.length === 1){
            return parseTerm(terms[0]);
        }
        return {
            kind: 'combine',
            combine: combine,
            children: terms.map(parseTerm)
        };
    }

    // Either a min()/max() call wrapping another expression, or a plain formula.
    function parseTerm(term){
        let open = term.indexOf('(');
        if (open !== -1){
            let name = term.substring(0, open).trim().toLowerCase();
            let close = matchingParen(term, open);
            if ((name === 'min' || name === 'max') && close !== -1 && term.substring(close + 1).trim() === ''){
                return parseExpression(term.substring(open + 1, close), name);
            }
        }
        return { kind: 'formula', formula: term };
    }

    // Every formula in a setting, in the order it was written, whatever it is nested inside.
    function collectFormulas(node){
        if (node.kind === 'formula'){
            return [node.formula];
        }
        let formulas = [];
        for (let i = 0; i < node.children.length; i++){
            formulas = formulas.concat(collectFormulas(node.children[i]));
        }
        return formulas;
    }

    function formulaBranches(setting){
        return collectFormulas(parseSetting(setting));
    }

    // The branch a one-formula decision has to look at: which endpoint to try first, and
    // whether a Torn key is needed at all.
    function firstBranch(setting){
        return formulaBranches(setting)[0];
    }

    // [avg] / [average]: the item market's average sale price (what the market page calls the
    // market price). Distinct from [market], Torn's item "market value" figure.
    function isAverageFormula(formula){
        let token = bracketToken(formula);
        return token === 'avg' || token === 'average';
    }

    function sourceOf(formula){
        let token = bracketToken(formula);
        if (token === 'market'){
            return SOURCE_MARKET_VALUE;
        }
        if (token === 'bazaar' || token.indexOf('bazaar:') == 0){
            return SOURCE_BAZAAR;
        }
        return SOURCE_ITEM_MARKET;
    }

    // What a [bazaar...] formula reads: a listing slot, the bazaar average, or the median listing.
    function bazaarSelector(formula){
        let argument = bracketToken(formula).substring('bazaar'.length).replace(/^:/, '').trim();
        if (argument === 'avg' || argument === 'average'){
            return { kind: 'avg' };
        }
        if (argument === 'median'){
            return { kind: 'median' };
        }
        let slot = parseInt(argument, 10);
        return { kind: 'slot', index: isNaN(slot) ? 0 : slot };
    }

    // True for both the item-market [median] and the bazaar [bazaar:median].
    function isMedianFormula(formula){
        let token = bracketToken(formula);
        return token === 'median' || token === 'bazaar:median';
    }

    // Which listing a slot-based formula wants, for either listing source.
    function listingSlot(formula){
        if (sourceOf(formula) === SOURCE_BAZAAR){
            let selector = bazaarSelector(formula);
            return selector.kind === 'slot' ? selector.index : 0;
        }
        let token = bracketToken(formula);
        let slot = parseInt(token, 10);
        return isNaN(slot) ? 0 : slot;
    }

    // ---- Cross-origin transport -------------------------------------------------------------
    // Torn's CSP and weav3r's CORS headers both police what the page itself issues, so weav3r
    // has to be reached from outside the page. Every userscript manager offers a way to do that;
    // they just disagree on its name. Detection is by typeof so an undeclared name never throws.

    function crossOriginGet(url){
        if (typeof GM_xmlhttpRequest === 'function'){
            return gmGet(GM_xmlhttpRequest, url);
        }
        if (typeof GM !== 'undefined' && GM != null && typeof GM.xmlHttpRequest === 'function'){
            return gmGet(GM.xmlHttpRequest.bind(GM), url);
        }
        // Torn PDA builds before GM_xmlhttpRequest support expose this instead.
        if (typeof PDA_httpGet === 'function'){
            return pdaGet(url);
        }
        return null;
    }

    // The name of the transport a call would use, for error messages that have to distinguish
    // "weav3r said no" from "the browser never let us ask".
    function crossOriginTransport(){
        if (typeof GM_xmlhttpRequest === 'function'){
            return 'GM_xmlhttpRequest';
        }
        if (typeof GM !== 'undefined' && GM != null && typeof GM.xmlHttpRequest === 'function'){
            return 'GM.xmlHttpRequest';
        }
        if (typeof PDA_httpGet === 'function'){
            return 'PDA_httpGet';
        }
        return 'fetch';
    }

    function gmGet(request, url){
        return new Promise(function(resolve, reject){
            request({
                method: 'GET',
                url: url,
                headers: { 'Accept': 'application/json' },
                timeout: WEAV3R_TIMEOUT_MS,
                onload: function(response){
                    resolve({ status: response.status, text: response.responseText ?? '' });
                },
                onerror: function(){ reject(new Error('network error')); },
                onabort: function(){ reject(new Error('aborted')); },
                ontimeout: function(){ reject(new Error('timed out')); }
            });
        });
    }

    // PDA_httpGet resolves to a response whose body is either already a string or behind a
    // text() call, depending on the PDA build; both shapes are normalised here.
    function pdaGet(url){
        return Promise.resolve(PDA_httpGet(url)).then(function(response){
            if (response == null){
                throw new Error('empty PDA response');
            }
            let status = response.status ?? 200;
            if (typeof response.responseText === 'string'){
                return { status: status, text: response.responseText };
            }
            if (typeof response.text === 'function'){
                return Promise.resolve(response.text()).then(function(text){
                    return { status: status, text: String(text ?? '') };
                });
            }
            return { status: status, text: String(response) };
        });
    }

    // One entry point for every weav3r call: the manager's transport when there is one, plain
    // fetch only as a last resort so a manager-less environment still gets to try.
    async function requestJson(url){
        let pending = crossOriginGet(url);
        if (pending == null){
            let fetched = await fetch(url, { headers: { 'Accept': 'application/json' } });
            return { status: fetched.status, ok: fetched.ok, text: await fetched.text() };
        }
        let response = await pending;
        return {
            status: response.status,
            ok: response.status >= 200 && response.status < 300,
            text: response.text
        };
    }

    function parseJsonBody(text){
        try {
            return JSON.parse(text);
        } catch (error) {
            throw new Error('non-JSON response body');
        }
    }

    // A failure on the plain-fetch path means the page, not weav3r, refused the call, and the
    // two need very different fixes — so the message says which one the user is looking at.
    function describeTransportFailure(error){
        let reason = error == null ? 'unknown error' : (error.message ?? String(error));
        if (crossOriginTransport() !== 'fetch'){
            return reason;
        }
        return reason + ' (this userscript manager exposes no cross-origin request API, so the'
            + ' call had to go through the page, where Torn\'s CSP and weav3r\'s CORS policy both'
            + ' apply — update the script in your manager so its GM_xmlhttpRequest grant is'
            + ' picked up)';
    }

    // Shape a weav3r failure like a Torn error payload so one set of handlers covers both.
    // A 429 borrows Torn's rate-limit code, which already drives the Fill All back-off.
    // A failed row on its own tells the user nothing, so the reason is logged and toasted too.
    function weav3rError(status, message){
        let text = "weav3r: " + message;
        console.error("[FreakyMarketHelper] " + text);
        if (Date.now() - lastWeav3rNoticeTs >= WEAV3R_NOTICE_THROTTLE_MS){
            lastWeav3rNoticeTs = Date.now();
            showToast('Bazaar prices unavailable — ' + text);
        }
        return { error: { code: status === 429 ? 5 : -1, error: text } };
    }

    // Like weav3rError, but for failures that say weav3r itself is down (no response, or a 5xx):
    // those are remembered briefly so the rest of a Fill All run fails fast instead of waiting
    // out the timeout once per row. A 429 is left to the rate-limit back-off, and an error
    // payload about one item says nothing about the others, so neither is remembered.
    function weav3rOutage(status, message){
        let result = weav3rError(status, message);
        weav3rFailure = { until: Date.now() + WEAV3R_FAILURE_TTL_MS, message: result.error.error };
        return result;
    }

    async function fetchWeav3rItem(itemId){
        let cached = weav3rItemCache.get(itemId);
        if (cached != null && (Date.now() - cached.ts) < WEAV3R_ITEM_TTL_MS){
            return cached.payload;
        }
        if (weav3rFailure != null && Date.now() < weav3rFailure.until){
            return { error: { code: -1, error: weav3rFailure.message } };
        }
        let payload;
        try {
            let response = await requestJson(weav3rItemUrl.replace("{itemId}", itemId));
            if (!response.ok){
                return response.status >= 500
                    ? weav3rOutage(response.status, "HTTP " + response.status)
                    : weav3rError(response.status, "HTTP " + response.status);
            }
            payload = parseJsonBody(response.text);
        } catch (error) {
            return weav3rOutage(0, describeTransportFailure(error));
        }
        // weav3r reports failures as a bare string, unlike Torn's {code, error} object.
        if (payload == null || payload.error != null){
            return weav3rError(0, payload == null ? "empty response" : String(payload.error));
        }
        weav3rFailure = null;
        weav3rItemCache.set(itemId, { ts: Date.now(), payload: payload });
        return payload;
    }

    // The bulk snapshot carries every item's average at once, so a whole Fill All run on
    // [bazaar:avg] costs a single request instead of one per row.
    async function fetchWeav3rAll(){
        if (weav3rAllCache != null && (Date.now() - weav3rAllCache.ts) < WEAV3R_ALL_TTL_MS){
            return weav3rAllCache.byId;
        }
        let response = await requestJson(weav3rAllUrl);
        if (!response.ok){
            throw new Error("weav3r snapshot HTTP " + response.status);
        }
        let payload = parseJsonBody(response.text);
        let byId = new Map();
        (payload.items ?? []).forEach(function(item){ byId.set(Number(item.item_id), item); });
        weav3rAllCache = { ts: Date.now(), byId: byId };
        return byId;
    }

    // The snapshot has no listings, so only an average request can be served from it; everything
    // else needs the per-item endpoint. A snapshot failure just falls through to that endpoint.
    async function fetchBazaarData(formula, itemId){
        if (bazaarSelector(formula).kind === 'avg'){
            try {
                let row = (await fetchWeav3rAll()).get(Number(itemId));
                if (row != null){
                    return { item_id: itemId, bazaar_average: row.bazaar_average, market_price: row.market_price, listings: [] };
                }
            } catch (error) {
                console.warn("[FreakyMarketHelper] weav3r snapshot unavailable, using the per-item endpoint:", error);
            }
        }
        return fetchWeav3rItem(itemId);
    }

    // How old a listing's last crawler check is, in ms. weav3r is expected to send unix seconds,
    // but a value too large to be seconds is read as milliseconds rather than trusted blindly.
    // A listing with no usable timestamp counts as infinitely old.
    function listingAgeMs(listing){
        let stamp = Number(listing.last_checked);
        if (!isFinite(stamp) || stamp <= 0){
            return Infinity;
        }
        let stampMs = stamp < 1e12 ? stamp * 1000 : stamp;
        return Date.now() - stampMs;
    }

    // Normalise weav3r listings to the {price, amount} shape GetPrice and the prices popup speak.
    // The sponsored slot goes first — a paid placement must never set your price — then listings
    // far under the average (outliers, not competition) and ones the crawler has not re-confirmed
    // lately, unless dropping the stale ones would leave nothing at all. The result is sorted
    // cheapest-first, because [bazaar] and [bazaar:N] read positions and must not depend on the
    // order weav3r happens to send.
    function normaliseBazaarListings(data){
        let floor = data.bazaar_average == null ? 0 : data.bazaar_average * BAZAAR_SANITY_FLOOR_RATIO;
        let usable = (data.listings ?? []).filter(function(listing){
            let price = Number(listing.price);
            return listing.sponsored !== 1 && isFinite(price) && price > 0 && price >= floor;
        });
        let fresh = usable.filter(function(listing){
            return listingAgeMs(listing) <= WEAV3R_STALE_LISTING_MS;
        });
        return (fresh.length > 0 ? fresh : usable).map(function(listing){
            let quantity = Number(listing.quantity);
            return {
                price: Number(listing.price),
                amount: (isFinite(quantity) && quantity > 0) ? Math.floor(quantity) : 1
            };
        }).sort(function(a, b){ return a.price - b.price; });
    }

    // The PDA placeholder is not a key: an un-substituted '###PDA-APIKEY###' would only ever
    // earn a code-2 error from Torn.
    function hasUsableApiKey(){
        return typeof apiKey === 'string' && apiKey.indexOf('PDA-APIKEY') === -1 && apiKey.length === 16;
    }

    // A bazaar-only setup never calls Torn, so it must never be asked for a key. Any other
    // source among the active formulas — including the bare default — still needs one.
    function needsTornApiKey(){
        if (isBazaarPage && dollarBazaar){
            return false;
        }
        return (isBazaarPage ? [bazaarDeltaRaw] : [priceDeltaRaw].concat(Object.values(categoryDeltas))).some(function(setting){
            return formulaBranches(setting).some(function(branch){
                return sourceOf(branch) !== SOURCE_BAZAAR;
            });
        });
    }

    function buildTornPriceUrl(source, itemId){
        return (source === SOURCE_MARKET_VALUE ? itemUrl : marketUrlV2)
            .replace("{itemId}", itemId)
            .replace("{apiKey}", apiKey);
    }

    async function fetchForSource(source, formula, itemId){
        if (source === SOURCE_BAZAAR){
            return fetchBazaarData(formula, itemId);
        }
        return fetch(buildTornPriceUrl(source, itemId)).then(response => response.json());
    }

    // Maps a Torn API error payload to the popup-friendly {price, amount:0, status} object,
    // or null when the response carries no error.
    function mapApiError(data){
        if (data.error == null){
            return null;
        }
        switch (data.error.code){
            case 2:
                apiKey = null;
                localStorage.removeItem("freaky-market-helper-apikey");
                console.error("[FreakyMarketHelper] Incorrect Api Key:", data);
                return {"price": 'Wrong API key!', "amount": 0, "status": 'invalid-key'};
            case 5:
                console.warn("[FreakyMarketHelper] API rate limit reached:", data);
                return {"price": 'Rate limited!', "amount": 0, "status": 'rate-limited'};
            case 9:
                console.warn("[FreakyMarketHelper] The API is temporarily disabled, please try again later");
                return {"price": 'API is OFF!', "amount": 0, "status": 'error'};
            default:
                console.error("[FreakyMarketHelper] Error:", data.error.error);
                return {"price": String(data.error.error), "amount": 0, "status": 'error'};
        }
    }

    // Turns a (non-error) response into the price shape consumed by GetPrice:
    // a {price, amount:1} object for a scalar source ([market], [bazaar:avg]), otherwise a
    // listings array. Returns null when a bazaar source has nothing usable, which tells the
    // caller to fall back to the item market.
    function parsePrices(data, itemId, source, formula){
        if (source === SOURCE_MARKET_VALUE){
            let entry = data.items != null ? data.items[itemId] : null;
            let value = entry != null ? Number(entry.market_value) : NaN;
            if (!isFinite(value) || value <= 0){
                return {"price": 'No market value!', "amount": 0, "status": 'error'};
            }
            return {"price": value, "amount": 1, "label": 'Market value'};
        }
        if (source === SOURCE_BAZAAR){
            if (bazaarSelector(formula).kind === 'avg'){
                return data.bazaar_average == null ? null : {"price": data.bazaar_average, "amount": 1, "label": 'Bazaar average'};
            }
            let listings = normaliseBazaarListings(data);
            return listings.length > 0 ? listings : null;
        }
        if (data.itemmarket.listings.length === 0){
            return {"price": 'No listings!', "amount": 0, "status": 'error'};
        }
        if (data.itemmarket.listings[0].price == null){
            console.warn("[FreakyMarketHelper] The API is temporarily disabled, please try again later");
            return {"price": 'API is OFF!', "amount": 0, "status": 'error'};
        }
        // temporary hotfix to avoid wrong prices
        if (data.itemmarket.item.id != itemId){
            return {"price": 'API is BROKEN!', "amount": 0, "status": 'error'};
        }
        // [avg] is the item market's own average sale price. It arrives in the same response as
        // the listings, so it costs no extra request.
        let average = Number(data.itemmarket.item.average_price);
        // Slot formulas ([0], [1]...) count from the cheapest listing, so the order must not
        // depend on how the API happens to send them.
        let listings = data.itemmarket.listings.slice().sort(function(a, b){ return Number(a.price) - Number(b.price); });
        if (isAverageFormula(formula)){
            if (!isFinite(average) || average <= 0){
                return {"price": 'No average price!', "amount": 0, "status": 'error'};
            }
            // The listings ride along so the popup can still show what is on sale.
            return {"price": average, "amount": 1, "label": 'Average sale price', "listings": listings};
        }
        listings.averagePrice = isFinite(average) && average > 0 ? average : null;
        return listings;
    }

    // weav3r carries no item type, so a bazaar response can never teach us a category — the
    // caller keeps its cached guess and re-learns from Torn at the next expiry.
    function readCategoryFromData(data, itemId, source){
        try {
            if (source === SOURCE_MARKET_VALUE){
                return (data.items && data.items[itemId]) ? (data.items[itemId].type ?? null) : null;
            }
            if (source === SOURCE_BAZAAR){
                return null;
            }
            return (data.itemmarket && data.itemmarket.item) ? (data.itemmarket.item.type ?? null) : null;
        } catch (error) {
            return null;
        }
    }

    // Resolve the formula to use for an item: a per-category override (matched on the item's
    // type, case-insensitively) if set, otherwise the global default.
    function getEffectiveDelta(category){
        if (category != null){
            let override = categoryDeltas[String(category).trim().toLowerCase()];
            if (override != null && String(override).trim() !== ''){
                return String(override).trim();
            }
        }
        return priceDeltaRaw;
    }

    // Can a response already fetched for this item answer for this branch too?
    function preloadMatches(preloaded, branch, source){
        if (preloaded == null || preloaded.source !== source){
            return false;
        }
        // The two bazaar reads differ: [bazaar:avg] comes from the bulk snapshot, every other
        // selector from the per-item endpoint, so only a matching kind may reuse a response.
        return source !== SOURCE_BAZAAR ||
            (bazaarSelector(preloaded.formula).kind === 'avg') === (bazaarSelector(branch).kind === 'avg');
    }

    // Price one branch of a setting. `allowFallback` is off while several branches compete:
    // the user has already named their own alternative, so a thin bazaar item should let the
    // next branch answer instead of quietly spending a Torn call on the item market.
    async function priceBranch(branch, itemId, category, preloaded, allowFallback){
        let source = sourceOf(branch);
        let data = preloadMatches(preloaded, branch, source)
            ? preloaded.data
            : await fetchForSource(source, branch, itemId);
        let error = mapApiError(data);
        if (error != null){
            return { prices: error, formula: branch, category: category };
        }
        let prices = parsePrices(data, itemId, source, branch);
        if (prices == null && !allowFallback){
            return { prices: null, formula: branch, category: category };
        }
        return withBazaarFallback(prices, branch, source, itemId, category);
    }

    // What a branch would actually fill, or null when it errored or priced nothing. A formula
    // stored before Save started validating them can still throw here, and that is one dead
    // branch rather than a dead row.
    function branchPrice(result){
        try {
            let price = GetPrice(result.prices, result.formula);
            return typeof price === 'number' && isFinite(price) ? price : null;
        } catch (error) {
            console.warn("[FreakyMarketHelper] Formula '" + result.formula + "' could not be applied:", error);
            return null;
        }
    }

    // Walk the parsed setting and pick the winning branch: the highest under max(), the lowest
    // under min(), with a nested call resolved to its own winner first. `priced` holds what
    // every formula came out at; a formula that priced nothing sits the comparison out, and a
    // call whose every formula priced nothing is null to the level above it.
    function chooseBranch(node, priced){
        if (node.kind === 'formula'){
            let entry = priced.get(node.formula);
            return (entry != null && entry.price != null) ? entry : null;
        }
        let best = null;
        for (let i = 0; i < node.children.length; i++){
            let candidate = chooseBranch(node.children[i], priced);
            if (candidate == null){
                continue;
            }
            if (best == null || (node.combine === 'min' ? candidate.price < best.price : candidate.price > best.price)){
                best = candidate;
            }
        }
        return best;
    }

    // Price every formula in a setting, then let the min()/max() tree pick which one fills. One
    // formula takes exactly the path, and costs exactly the calls, it did before any of this,
    // and a formula written twice in the same setting is still fetched once.
    // A branch that genuinely fails (rate limit, bad key, API error, a thrown exception) fails
    // the whole row. Dropping it would silently turn a floor or ceiling into no floor or
    // ceiling, and would hide rate-limit and key errors from the Fill All back-off. A branch
    // that merely has nothing to say (a thin bazaar item) still just sits the comparison out.
    async function priceSetting(setting, itemId, category, preloaded){
        let root = parseSetting(setting);
        let formulas = collectFormulas(root);
        if (root.kind === 'formula'){
            return priceBranch(root.formula, itemId, category, preloaded, true);
        }
        let priced = new Map();
        for (let i = 0; i < formulas.length; i++){
            if (priced.has(formulas[i])){
                continue;
            }
            let result;
            try {
                result = await priceBranch(formulas[i], itemId, category, preloaded, false);
            } catch (error) {
                console.error("[FreakyMarketHelper] '" + formulas[i] + "' failed for item " + itemId + ":", error);
                return { prices: {"price": 'Failed!', "amount": 0, "status": 'error'}, formula: formulas[i], category: category };
            }
            if (result.prices != null && getPricesStatus(result.prices) !== 'ok'){
                return result;
            }
            let price = branchPrice(result);
            if (price == null){
                console.warn("[FreakyMarketHelper] '" + formulas[i] + "' priced nothing for item " + itemId + ".");
            }
            priced.set(formulas[i], { result: result, price: price });
        }
        let best = chooseBranch(root, priced);
        // Nothing priced: re-run the first formula the ordinary way, so the row reports the same
        // error — and gets the same item-market fallback — as a setting with no pipes at all.
        return best != null ? best.result : priceBranch(formulas[0], itemId, category, preloaded, true);
    }

    // Fetch pricing for an item using the price source its (possibly per-category) formula needs.
    // The item's category is read from the first response and cached; only the first ever fill of
    // an item whose category overrides the source costs a second request.
    // Returns {prices, formula, category} — the category also drives the quantity mode.
    // Note: without a usable Torn API key nothing can teach us an item's category (weav3r has no
    // item types), so per-category price and quantity overrides cannot apply to those items.
    async function fetchPricingForItem(itemId){
        try {
            if (isBazaarPage && dollarBazaar){
                return { prices: [{ price: 1, amount: 1 }], formula: '[0]', category: null };
            }
            if (isBazaarPage){
                // Bazaar rows use their own price setting and have no item-market categories.
                return await priceSetting(bazaarDeltaRaw, itemId, null, null);
            }
            // No per-category overrides of either kind → category is irrelevant; behave like
            // the default path.
            if (Object.keys(categoryDeltas).length === 0 && !hasCategoryQuantityOverrides()){
                return await priceSetting(priceDeltaRaw, itemId, null, null);
            }

            let cached = getCachedCategory(itemId);
            let expired = cached == null || (Date.now() - cached.ts) > CATEGORY_TTL_MS;
            let guessCategory = cached != null ? cached.type : null;
            // Only the first branch decides which endpoint to try first; the rest are priced
            // once the category is known.
            let guessFormula = firstBranch(getEffectiveDelta(guessCategory));
            // When stale/unknown, force the items endpoint so we definitively re-learn the type even
            // if the chosen source omits it; otherwise guess from the cache to stay 1 call.
            // Without a key that refresh can only fail, and failing it would take a bazaar-only
            // setup down with it — so there we price from the guess and re-learn the type later.
            let firstSource = (expired && hasUsableApiKey()) ? SOURCE_MARKET_VALUE : sourceOf(guessFormula);
            let data = await fetchForSource(firstSource, guessFormula, itemId);
            let error = mapApiError(data);
            if (error != null){
                return { prices: error, formula: guessFormula, category: guessCategory };
            }
            let actualType = readCategoryFromData(data, itemId, firstSource);
            let category = actualType != null ? actualType : guessCategory;
            if (actualType != null && (cached == null || cached.type !== actualType || expired)){
                cacheItemCategory(itemId, actualType);
            }
            return await priceSetting(getEffectiveDelta(category), itemId, category,
                                { source: firstSource, formula: guessFormula, data: data });
        } catch (error) {
            console.error("[FreakyMarketHelper] Error fetching data:", error);
            // The same shape as every other error, so the row shows "Failed!" rather than NaN.
            return { prices: {"price": 'Failed!', "amount": 0, "status": 'error'}, formula: priceDeltaRaw, category: null };
        }
    }

    // A bazaar source weav3r cannot answer for this item falls back to Torn's item market rather
    // than failing the row, so one thin item never stops a Fill All run. The delta carries over;
    // the selector cannot, so the fallback formula is the bare delta.
    async function withBazaarFallback(prices, formula, source, itemId, category){
        if (prices != null){
            return { prices: prices, formula: formula, category: category };
        }
        console.warn("[FreakyMarketHelper] No usable weav3r bazaar price for item " + itemId + "; using the item market.");
        let fallbackFormula = stripDeltaBracket(formula);
        if (!hasUsableApiKey()){
            // A bazaar-only setup was never asked for a key, so there is nothing to fall back
            // with. Say that instead of spending a call on a guaranteed key error.
            // Called for its logging and toast; the row needs the short cell label, not the payload.
            weav3rError(0, "no price for item " + itemId + ", and no API key is set for the item-market fallback");
            return { prices: {"price": 'No bazaar price!', "amount": 0, "status": 'error'}, formula: fallbackFormula, category: category };
        }
        let data = await fetchForSource(SOURCE_ITEM_MARKET, fallbackFormula, itemId);
        let error = mapApiError(data);
        if (error != null){
            return { prices: error, formula: fallbackFormula, category: category };
        }
        return { prices: parsePrices(data, itemId, SOURCE_ITEM_MARKET, fallbackFormula), formula: fallbackFormula, category: category };
    }

    // A listed price is never allowed to reach zero or go negative: "-1" on a $1 item would
    // otherwise fill 0, which Torn rejects.
    // The price is rounded to the chosen step last, after the discount, so the rounding is the
    // only thing that moves the final number.
    function clampPrice(value){
        let price = Math.round(value);
        if (roundingStep > 0){
            let rounder = roundingDir === 'down' ? Math.floor : (roundingDir === 'up' ? Math.ceil : Math.round);
            price = rounder(price / roundingStep) * roundingStep;
        }
        return Math.max(1, price);
    }

    // The number a formula's discount is applied to, and what to call it in the popup.
    function getBasePrice(prices, formula){
        if (prices.price !== undefined){
            // A scalar source ([market], [avg], [bazaar:avg]) arrives as one {price, amount} object.
            return { value: Number(prices.price), label: prices.label ?? 'Price' };
        }
        if (isMedianFormula(formula)){
            return { value: getMedianPrice(prices), label: 'Median listing' };
        }
        let slot = Math.min(listingSlot(formula), prices.length - 1);
        return { value: Number(prices[slot].price), label: slot === 0 ? 'Cheapest listing' : 'Listing #' + (slot + 1) };
    }

    function GetPrice(prices, formula){
        if (prices == null){
            return 'No prices loaded';
        }
        if (prices.amount == 0){
            return prices.price;
        }
        let base = getBasePrice(prices, formula);
        if (!isFinite(base.value)){
            throw new Error('No base price for ' + formula);
        }
        return clampPrice(performOperation(base.value, stripDeltaBracket(formula)));
    }

    // Everything the popup shows about a fill: the formula, what it was applied to, and the result.
    function describeFill(prices, formula){
        try {
            let base = getBasePrice(prices, formula);
            let result = GetPrice(prices, formula);
            return { formula: formula, label: base.label, base: base.value, price: result,
                     average: Array.isArray(prices) ? prices.averagePrice : null };
        } catch (error) {
            return null;
        }
    }

    async function handleFillClick(event, itemId){
        await triggerFill(event.currentTarget || event.target, itemId);
    }

    async function triggerFill(target, itemId){
        let isFill = target.getAttribute('data-action-flag') == 'fill';
        // A manual Fill on an excluded item still fills — the exclusion only governs Fill All —
        // but it says so, so an accidental click on the wrong row is obvious straight away.
        let itemIdNum = parseInt(itemId, 10);
        if (!isNaN(itemIdNum) && excluded.has(itemIdNum) && isFill){
            showToast("Heads up: this item is marked excluded (⊘). Filling it anyway because you clicked Fill.");
        }
        if (isFill){
            // Without this a first-time user's single Fill sends the placeholder key to Torn,
            // which answers with a key error. Clearing a row needs no key.
            checkApiKey();
            if (needsTornApiKey() && !hasUsableApiKey()){
                showToast('A public Torn API key is needed for this price source. Add one in the settings (⚙).');
                return;
            }
        }
        await performFill(target, itemId, true);
    }

    function hasCategoryQuantityOverrides(){
        return Object.keys(categoryQuantities).length > 0;
    }

    function isMaxQuantityMode(mode){
        let normalised = String(mode ?? 'max').trim().toLowerCase();
        return normalised === '' || normalised === 'max';
    }

    // Only "max-N" needs to know how many of the item you actually own.
    function needsRowMaximum(mode){
        return /^max\s*-\s*\d+$/.test(String(mode ?? '').trim().toLowerCase());
    }

    function isKnownQuantityMode(mode){
        let normalised = String(mode ?? '').trim().toLowerCase();
        return isMaxQuantityMode(normalised) || normalised === 'skip' || normalised === 'none' ||
            /^\d+$/.test(normalised) || needsRowMaximum(normalised);
    }

    // True for the modes that never list anything, whatever the row holds.
    function isSkipQuantityMode(mode){
        let normalised = String(mode ?? '').trim().toLowerCase();
        return normalised === 'skip' || normalised === 'none' || /^0+$/.test(normalised);
    }

    // Resolve a quantity mode against a row's maximum. Returns a positive integer to list, or
    // null when the row should be left completely untouched ("keep them all").
    // Accepted syntax: "max", "max-N", a plain number, and "skip"/"none"/"0".
    function resolveQuantity(maxQuantity, mode){
        let normalised = String(mode ?? 'max').trim().toLowerCase();
        let fixed = normalised.match(/^(\d+)$/);
        let maxMinus = normalised.match(/^max\s*-\s*(\d+)$/);
        if (normalised === 'skip' || normalised === 'none' || (fixed && parseInt(fixed[1], 10) === 0)){
            return null;
        }
        if (fixed){
            // A fixed amount doesn't need the row's maximum — Torn clamps anything too large.
            let wanted = parseInt(fixed[1], 10);
            return maxQuantity != null ? Math.min(wanted, maxQuantity) : wanted;
        }
        if (maxMinus){
            if (maxQuantity == null){
                console.warn("[FreakyMarketHelper] Row quantity unknown — leaving the row alone rather than risk listing a kept copy.");
                return null;
            }
            let wanted = maxQuantity - parseInt(maxMinus[1], 10);
            return wanted > 0 ? wanted : null;
        }
        if (!isMaxQuantityMode(normalised)){
            console.warn("[FreakyMarketHelper] Unrecognised quantity mode '" + mode + "', using max.");
        }
        return maxQuantity;
    }

    // Same lookup as getEffectiveDelta, for the quantity mode.
    function getEffectiveQuantity(category){
        if (category != null){
            let override = categoryQuantities[String(category).trim().toLowerCase()];
            if (override != null && String(override).trim() !== ''){
                return String(override).trim();
            }
        }
        return quantityModeRaw;
    }

    // Decide, before any price is fetched, that a Fill will list nothing, so a "skip" category
    // does not spend an API call on a price it will never use. Only done when the mode is
    // certain: an item whose category is not cached yet, with per-category quantity overrides
    // in play, might resolve to a different mode, so it goes through the normal path.
    // A quantity the user typed themselves still wins over the mode, as it does in applyQuantity.
    function shouldSkipBeforePricing(target, itemId){
        if (getCurrentPage() !== pages.AddItems){
            return false;
        }
        let cached = getCachedCategory(itemId);
        if (cached == null && hasCategoryQuantityOverrides()){
            return false;
        }
        let mode = getEffectiveQuantity(cached != null ? cached.type : null);
        if (!isSkipQuantityMode(mode)){
            return false;
        }
        let parentRow = findInfoRow(target);
        if (parentRow != null){
            let amountInput = rowAmountInputs(parentRow)[0] ?? null;
            if (amountInput != null && amountInput.value.length !== 0 && parseInt(amountInput.value) >= 1){
                return false;
            }
        }
        return true;
    }

    function setQuantityInputs(inputs, value){
        inputs.forEach(x => { x.value = value; });
        // The native-setter route, so React notices on pages (the bazaar) that need it.
        setReactValue(inputs[0], value);
    }

    // Waits two frames for Torn to react, but never longer than a short timeout: in a
    // background tab requestAnimationFrame does not fire, and an await on it alone would hang.
    function nextFrame(){
        return new Promise(function(resolve){
            let done = false;
            let finish = function(){
                if (!done){
                    done = true;
                    resolve();
                }
            };
            requestAnimationFrame(function(){ requestAnimationFrame(finish); });
            setTimeout(finish, 150);
        });
    }

    // Torn clamps the amount input to however many of the item you own, so writing an absurd
    // value and reading it back is the most reliable way to learn the row's maximum. Falls back
    // to the "xN" count in the row's own text if the clamp doesn't materialise.
    async function discoverMaxQuantity(quantityInputs, parentRow){
        setQuantityInputs(quantityInputs, Number.MAX_SAFE_INTEGER);
        await nextFrame();
        let clamped = parseInt(String(quantityInputs[0].value).replace(/[^\d]/g, ''), 10);
        setQuantityInputs(quantityInputs, '');
        if (!isNaN(clamped) && clamped > 0 && clamped < Number.MAX_SAFE_INTEGER){
            return clamped;
        }
        let match = String(parentRow.textContent).match(/\bx\s?(\d[\d,]*)/i);
        if (match != null){
            let parsed = parseInt(match[1].replace(/,/g, ''), 10);
            if (!isNaN(parsed) && parsed > 0){
                return parsed;
            }
        }
        console.warn("[FreakyMarketHelper] Row maximum quantity could not be determined.");
        return null;
    }

    // Add Items rows only. Returns 'ok' once the row's amount is settled, or 'skipped' when the
    // quantity mode resolves to nothing to list — in which case the row is left untouched.
    async function applyQuantity(target, action, category, isAuto){
        let parentRow = findInfoRow(target);
        if (parentRow == null){
            return 'ok';
        }
        let mode = getEffectiveQuantity(category);
        let quantityInputs = rowAmountInputs(parentRow);
        if (isBazaarPage && parentRow.classList.contains('tmf-bz-row')){
            return applyBazaarQuantity(parentRow, quantityInputs, action, mode, isAuto);
        }
        if (quantityInputs.length === 0){
            // Single-copy rows (most clothing) carry a checkbox instead of an amount input,
            // so their maximum is 1 by definition.
            let checkbox = parentRow.querySelector('[class^=checkboxWrapper___] > [class^=checkboxContainer___] [type=checkbox]');
            if (checkbox == null){
                return 'ok';
            }
            if (action == 'fill'){
                if (resolveQuantity(1, mode) === null){
                    reportSkipped(mode, 1, isAuto);
                    return 'skipped';
                }
                if (!checkbox.checked){
                    checkbox.click();
                }
            } else if (checkbox.checked){
                checkbox.click();
            }
            return 'ok';
        }

        let hasUserAmount = quantityInputs[0].value.length !== 0 && parseInt(quantityInputs[0].value) >= 1;
        if (action == 'clear'){
            setQuantityInputs(quantityInputs, hasUserAmount ? '' : 0);
            return 'ok';
        }
        if (hasUserAmount){
            // An amount the user typed themselves wins over any quantity mode.
            quantityInputs[0].dispatchEvent(new Event("input", {bubbles: true}));
            return 'ok';
        }
        if (isMaxQuantityMode(mode) || !isKnownQuantityMode(mode)){
            // Unparseable modes fall back to "max" rather than silently listing nothing.
            if (!isKnownQuantityMode(mode)){
                console.warn("[FreakyMarketHelper] Unrecognised quantity mode '" + mode + "', using max.");
            }
            setQuantityInputs(quantityInputs, Number.MAX_SAFE_INTEGER); // Torn clamps it to what you own
            return 'ok';
        }
        let maxQuantity = needsRowMaximum(mode) ? await discoverMaxQuantity(quantityInputs, parentRow) : null;
        let resolved = resolveQuantity(maxQuantity, mode);
        if (resolved === null){
            setQuantityInputs(quantityInputs, '');
            reportSkipped(mode, maxQuantity, isAuto);
            return 'skipped';
        }
        setQuantityInputs(quantityInputs, resolved);
        return 'ok';
    }

    function reportSkipped(mode, maxQuantity, isAuto){
        let modeLabel = String(mode ?? 'max').trim();
        console.info("[FreakyMarketHelper] Row left untouched — quantity mode '" + modeLabel +
                     "' lists nothing out of " + (maxQuantity ?? "an unknown number") + ".");
        if (!isAuto){
            showToast(maxQuantity != null
                ? "Nothing listed — quantity mode \"" + modeLabel + "\" keeps all " + maxQuantity + " of this item."
                : "Nothing listed — quantity mode \"" + modeLabel + "\" keeps this item.");
        }
    }

    // showPopup=false is the auto-fill path: no prices popup, no input changes on
    // API errors. Returns "ok" | "skipped" | "rate-limited" | "invalid-key" | "error".
    async function performFill(target, itemId, showPopup){
        // The price boxes: inside the button's own price group, or, when the button sits beside the
        // item name (bazaar Manage), the ones in its row.
        let priceGroup = target.closest('.input-money-group');
        let priceRow = findRowWrapper(target);
        let priceInputs = (priceGroup ?? priceRow ?? target.parentNode).querySelectorAll('input.input-money');
        let action = target.getAttribute('data-action-flag');
        // Bazaar Manage: the button is an "Update" that re-prices on every click and never flips
        // to Clear.
        const isManageUpdate = isBazaarPage && getCurrentPage() === pages.ViewItems;
        if (isManageUpdate && action !== 'fill'){
            setActionFlag(target, 'fill');
            action = 'fill';
        }

        // Clearing needs no prices at all: no request, no popup, just empty the row.
        if (action !== 'fill'){
            if (getCurrentPage() == pages.AddItems){
                await applyQuantity(target, action, null, !showPopup);
            }
            switchActionFlag(target);
            priceInputs.forEach(x => {x.value = ''});
            priceInputs[0].dispatchEvent(new Event("input", {bubbles: true}));
            if (getCurrentPage() == pages.AddItems){
                removeListing(itemId);
            }
            return 'ok';
        }

        // A "skip" quantity mode lists nothing, so don't pay for a price it won't use.
        if (shouldSkipBeforePricing(target, itemId)){
            let cached = getCachedCategory(itemId);
            reportSkipped(getEffectiveQuantity(cached != null ? cached.type : null), null, !showPopup);
            return 'skipped';
        }

        let pricing = await fetchPricingForItem(itemId);
        let prices = pricing.prices;
        let status = getPricesStatus(prices);

        // No popup any more: a manual Fill reports its outcome in a short toast instead.
        if (showPopup && status !== 'ok') {
            showToast(prices != null && prices.price != null ? String(prices.price) : 'Could not price this item.');
        }
        if (status !== 'ok') {
            // Leave the row untouched on any failure — manual or auto. Writing the error text
            // into the inputs and flipping the button to "clear" would make the next click wipe
            // the row instead of retrying. The toast (manual path) shows the reason.
            return status;
        }

        // Quantity/checkbox handling only exists on the Add Items page. Your Items (view
        // listings) rows carry a remove-amount input instead — touching it would be wrong,
        // and the missing containers used to throw and abort the Fill All loop.
        if (getCurrentPage() == pages.AddItems){
            let quantityStatus = await applyQuantity(target, action, pricing.category, !showPopup);
            if (quantityStatus === 'skipped'){
                // Nothing is being listed, so leave the price (and the button state) alone.
                return 'skipped';
            }
        }

        let price = GetPrice(prices, pricing.formula);
        if (!isManageUpdate){
            switchActionFlag(target);
        }
        priceInputs.forEach(x => {x.value = price});
        priceInputs[0].dispatchEvent(new Event("input", {bubbles: true}));
        if (getCurrentPage() == pages.AddItems){
            await recordListing(target, itemId, price, describeFill(prices, pricing.formula));
        }
        return status;
    }

    function getPricesStatus(prices){
        if (Array.isArray(prices)){
            return 'ok';
        }
        if (prices != null && typeof prices === 'object'){
            return prices.amount === 0 ? (prices.status ?? 'error') : 'ok';
        }
        return 'error'; // anything unexpected
    }

    function getItemIdFromString(string){
        const match = string.match(/-(\d+)-/);
        if (match) {
            const number = match[1];
            return number;
        } else {
            console.error("[FreakyMarketHelper] ItemId not found!");
            return -1;
        }
    }

    function getItemIdFromImage(image){
        let numberPattern = /\/(\d+)\//;
        let match = image.src.match(numberPattern);
        if (match) {
            return parseInt(match[1], 10);
        } else {
            console.error("[FreakyMarketHelper] ItemId not found!");
            return -1;
        }
    }

    function setActionFlag(target, flag){
        target.setAttribute('data-action-flag', flag);
        // The row's select box mirrors the state: ticked while the row is filled.
        let rowWrapper = findRowWrapper(target);
        let selectBox = rowWrapper != null ? rowWrapper.querySelector('.tmf-select') : null;
        if (selectBox != null){
            selectBox.classList.toggle('tmf-select--on', flag === 'clear');
        }
        let button = target.querySelector('input.fmh-btn');
        let manage = isBazaarPage && getCurrentPage() === pages.ViewItems;
        target.classList.toggle('fmh-update', manage && flag !== 'clear');
        if (button != null){
            button.value = flag === 'clear' ? 'Clear' : (manage ? 'Update' : 'Fill');
        }
    }

    function switchActionFlag(target){
        setActionFlag(target, target.getAttribute('data-action-flag') === 'fill' ? 'clear' : 'fill');
    }

    // A bazaar row is whatever scanBazaarRows marked as one; on the Item Market it is Torn's own
    // wrapper classes. Both pages share the rest of the fill code through these helpers.
    function findRowWrapper(element){
        return findParentByCondition(element, (el) => String(el.className).indexOf('itemRowWrapper___') > -1 || (el.classList != null && el.classList.contains('tmf-bz-row')));
    }

    function findInfoRow(element){
        return findParentByCondition(element, (el) => String(el.className).indexOf('info___') > -1 || (el.classList != null && el.classList.contains('tmf-bz-row')));
    }

    // The row's amount box: Torn's money-style input on the Item Market, a plain text box on the bazaar.
    function rowAmountInputs(row){
        return Array.from(row.querySelectorAll('[class^=amountInputWrapper___] .input-money-group > .input-money, .amount .clear-all:not([type=hidden])'));
    }

    function findParentByCondition(element, conditionFn){
        let currentElement = element;
        while (currentElement !== null) {
            if (conditionFn(currentElement)) {
                return currentElement;
            }
            currentElement = currentElement.parentElement;
        }
        return null;
    }

    // Third-party text (weav3r error strings, listing fields) ends up in innerHTML on a Torn
    // page; it is escaped first so a malformed or hostile response cannot inject markup.
    function escapeHtml(value){
        return String(value ?? '').replace(/[&<>"']/g, function(ch){
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function loadFavourites(){
        try {
            let stored = JSON.parse(localStorage.getItem(favouritesStorageKey) ?? "[]");
            return new Set(Array.isArray(stored) ? stored : []);
        } catch (error) {
            console.error("[FreakyMarketHelper] Failed to load favourites:", error);
            return new Set();
        }
    }

    function saveFavourites(){
        localStorage.setItem(favouritesStorageKey, JSON.stringify([...favourites]));
    }

    function loadExcluded(){
        try {
            let stored = JSON.parse(localStorage.getItem(excludedStorageKey) ?? "[]");
            return new Set(Array.isArray(stored) ? stored : []);
        } catch (error) {
            console.error("[FreakyMarketHelper] Failed to load excluded items:", error);
            return new Set();
        }
    }

    function saveExcluded(){
        localStorage.setItem(excludedStorageKey, JSON.stringify([...excluded]));
    }

    function getItemState(itemId){
        if (excluded.has(itemId)) {
            return 'excluded';
        }
        return favourites.has(itemId) ? 'favourite' : 'neutral';
    }

    // neutral → favourite → excluded → neutral. The three states are mutually exclusive.
    function cycleItemState(itemId){
        switch (getItemState(itemId)) {
            case 'neutral':
                favourites.add(itemId);
                break;
            case 'favourite':
                favourites.delete(itemId);
                excluded.add(itemId);
                break;
            default:
                excluded.delete(itemId);
                break;
        }
        saveFavourites();
        saveExcluded();
        let state = getItemState(itemId);
        document.querySelectorAll('.tmf-fav[data-tmf-item-id="' + itemId + '"]').forEach(function(el){
            renderFavIcon(el, state);
        });
    }

    function renderFavIcon(el, state){
        el.textContent = state === 'favourite' ? '★' : (state === 'excluded' ? '⊘' : '☆');
        el.classList.toggle('tmf-fav--on', state === 'favourite');
        el.classList.toggle('tmf-fav--off', state === 'excluded');
        el.title = state === 'favourite'
            ? 'Favourite — filled by Fill All. Click to exclude.'
            : (state === 'excluded'
               ? 'Excluded — never filled by Fill All, and a manual Fill warns first. Click to reset.'
               : 'Click to mark as a favourite (used by Fill All).');
    }

    function loadFillAllState(){
        try {
            let raw = localStorage.getItem(fillAllStateKey);
            if (!raw) {
                return null;
            }
            let parsed = JSON.parse(raw);
            if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') {
                return parsed;
            }
        } catch (error) {
            console.error("[FreakyMarketHelper] Failed to load Fill All position:", error);
        }
        return null;
    }

    function saveFillAllState(){
        localStorage.setItem(fillAllStateKey, JSON.stringify(fillAllState));
    }

    function setBarLeftTop(bar, left, top){
        bar.style.right = 'auto';
        bar.style.bottom = 'auto';
        bar.style.left = left + 'px';
        bar.style.top = top + 'px';
    }

    // Clamp the bar's top-left so it stays fully on-screen with a small margin.
    function clampBarLeftTop(bar, left, top){
        let maxLeft = Math.max(FILLALL_VIEWPORT_MARGIN_PX, window.innerWidth - bar.offsetWidth - FILLALL_VIEWPORT_MARGIN_PX);
        let maxTop = Math.max(FILLALL_VIEWPORT_MARGIN_PX, window.innerHeight - bar.offsetHeight - FILLALL_VIEWPORT_MARGIN_PX);
        return {
            left: Math.min(Math.max(FILLALL_VIEWPORT_MARGIN_PX, left), maxLeft),
            top: Math.min(Math.max(FILLALL_VIEWPORT_MARGIN_PX, top), maxTop)
        };
    }

    // Nearest viewport edge if the bar is within the snap threshold of it (or past it), else null.
    function nearestSnapEdge(bar){
        let r = bar.getBoundingClientRect();
        let distLeft = r.left;
        let distRight = window.innerWidth - r.right;
        let distTop = r.top;
        let distBottom = window.innerHeight - r.bottom;
        let min = Math.min(distLeft, distRight, distTop, distBottom);
        if (min > FILLALL_EDGE_SNAP_PX) {
            return null;
        }
        if (min === distLeft) { return 'left'; }
        if (min === distRight) { return 'right'; }
        if (min === distTop) { return 'top'; }
        return 'bottom';
    }

    // Push the bar flush against the given edge, keeping its cross-axis position on-screen.
    function snapBarToEdge(bar, edge){
        let maxLeft = Math.max(0, window.innerWidth - bar.offsetWidth);
        let maxTop = Math.max(0, window.innerHeight - bar.offsetHeight);
        let r = bar.getBoundingClientRect();
        let left = Math.min(Math.max(0, r.left), maxLeft);
        let top = Math.min(Math.max(0, r.top), maxTop);
        switch (edge) {
            case 'left': left = 0; break;
            case 'right': left = maxLeft; break;
            case 'top': top = 0; break;
            case 'bottom': top = maxTop; break;
        }
        setBarLeftTop(bar, left, top);
    }

    // Re-apply the persisted position/minimised state. Safe to call again on resize.
    function applyFillAllState(bar){
        if (fillAllState == null) {
            return; // never moved — keep the default CSS anchor (bottom-right)
        }
        bar.classList.toggle('tmf-fillall-bar--min', !!fillAllState.minimised);
        if (fillAllState.minimised && fillAllState.edge) {
            setBarLeftTop(bar, fillAllState.left, fillAllState.top);
            snapBarToEdge(bar, fillAllState.edge);
        } else {
            let clamped = clampBarLeftTop(bar, fillAllState.left, fillAllState.top);
            setBarLeftTop(bar, clamped.left, clamped.top);
        }
    }

    // Restore a minimised bar to its full size near where its handle sits.
    function expandFillAllBar(bar){
        bar.classList.remove('tmf-fillall-bar--min');
        let r = bar.getBoundingClientRect();
        let clamped = clampBarLeftTop(bar, r.left, r.top);
        setBarLeftTop(bar, clamped.left, clamped.top);
        fillAllState = { left: clamped.left, top: clamped.top, minimised: false, edge: null };
        saveFillAllState();
    }

    // Fold the panel down to its header, keeping it where it is.
    function collapseFillAllBar(bar){
        bar.classList.add('tmf-fillall-bar--min');
        let r = bar.getBoundingClientRect();
        let clamped = clampBarLeftTop(bar, r.left, r.top);
        setBarLeftTop(bar, clamped.left, clamped.top);
        fillAllState = { left: clamped.left, top: clamped.top, minimised: true, edge: null };
        saveFillAllState();
    }

    // End of a drag gesture: snap + minimise when dropped near an edge, otherwise stay expanded.
    function finishFillAllDrag(bar){
        bar.classList.remove('tmf-fillall-bar--dragging');
        let edge = nearestSnapEdge(bar);
        if (edge) {
            bar.classList.add('tmf-fillall-bar--min'); // changes size before we measure/snap
            snapBarToEdge(bar, edge);
            let r = bar.getBoundingClientRect();
            fillAllState = { left: r.left, top: r.top, minimised: true, edge: edge };
        } else {
            bar.classList.remove('tmf-fillall-bar--min');
            let r = bar.getBoundingClientRect();
            let clamped = clampBarLeftTop(bar, r.left, r.top);
            setBarLeftTop(bar, clamped.left, clamped.top);
            fillAllState = { left: clamped.left, top: clamped.top, minimised: false, edge: null };
        }
        saveFillAllState();
    }

    // Whole-bar drag with click/drag disambiguation: a clean tap still triggers the button
    // it landed on (or expands a minimised bar), while a drag moves the bar and suppresses the
    // trailing click.
    function attachFillAllDrag(bar){
        let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
        let candidate = false, dragging = false, suppressClick = false;

        let startTarget = null;
        function begin(clientX, clientY, target){
            if (target != null && target.closest && target.closest('input:not([type=button]),select')) {
                return;
            }
            startTarget = target || null;
            candidate = true;
            dragging = false;
            let r = bar.getBoundingClientRect();
            baseLeft = r.left;
            baseTop = r.top;
            startX = clientX;
            startY = clientY;
        }
        function move(clientX, clientY){
            if (!candidate) {
                return;
            }
            let dx = clientX - startX, dy = clientY - startY;
            if (!dragging) {
                if (Math.abs(dx) + Math.abs(dy) < FILLALL_DRAG_THRESHOLD_PX) {
                    return;
                }
                dragging = true;
                bar.classList.add('tmf-fillall-bar--dragging');
            }
            setBarLeftTop(bar, baseLeft + dx, baseTop + dy);
        }
        function end(){
            if (!candidate) {
                return;
            }
            candidate = false;
            if (dragging) {
                dragging = false;
                suppressClick = true;
                finishFillAllDrag(bar);
                // The click that follows a drag arrives right after this event. If none ever does
                // (a touch drag, or a mouse released outside the bar) the flag must not linger
                // and swallow the next genuine tap.
                setTimeout(function(){ suppressClick = false; }, 50);
            } else if (bar.classList.contains('tmf-fillall-bar--min')) {
                expandFillAllBar(bar);
            } else if (startTarget != null && startTarget.closest && startTarget.closest('.tmf-fillall-head')) {
                collapseFillAllBar(bar);
            }
        }

        bar.addEventListener('mousedown', function(e){ begin(e.clientX, e.clientY, e.target); });
        document.addEventListener('mousemove', function(e){ if (candidate) { move(e.clientX, e.clientY); } });
        document.addEventListener('mouseup', end);

        bar.addEventListener('touchstart', function(e){ let t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
        document.addEventListener('touchmove', function(e){
            if (!candidate) {
                return;
            }
            let t = e.touches[0];
            move(t.clientX, t.clientY);
            if (dragging) {
                e.preventDefault(); // stop the page scrolling while dragging
            }
        }, { passive: false });
        document.addEventListener('touchend', end);
        document.addEventListener('touchcancel', end);

        // Capture-phase on the bar itself: runs before any child's own click handler, so the
        // click that follows a drag never reaches Fill All or the settings cog. Listening on the
        // bar (rather than each button) also clears the flag when a drag ends on the grip.
        bar.addEventListener('click', function(e){
            if (suppressClick) {
                suppressClick = false;
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        }, true);
    }

    // "Quick changes": the everyday settings (price formula, quantity, rounding) inside the panel,
    // so they can be changed without opening Settings. Everything here reads and writes the same
    // profile Settings does, for the page you are on. The preset list is filled in the first time
    // the section is opened, because it is built from tables defined further down the script.
    function buildQuickChanges(){
        const box = document.createElement('div');
        box.className = 'tmf-quick';
        box.innerHTML =
            '<div class="tmf-quick-toggle"><span>&#9889;</span><span class="tmf-quick-label">Quick changes</span><span class="tmf-quick-arrow">&#9660;</span></div>' +
            '<div class="tmf-quick-panel">' +
                '<label>Preset</label><div class="tmf-quick-row"><select class="tmf-quick-preset"></select><button type="button" class="tmf-quick-btn tmf-quick-del" title="Delete the selected custom preset" disabled>&#10005;</button></div>' +
                '<label>Price formula</label><input type="text" class="tmf-quick-formula" spellcheck="false" autocomplete="off">' +
                '<div class="tmf-quick-note"></div>' +
                '<label>Quantity</label>' +
                '<select class="tmf-quick-qty">' +
                    '<option value="max">All</option><option value="max-1">Keep 1</option><option value="1">Just 1</option><option value="skip">Never list</option>' +
                '</select>' +
                '<label>Round price</label>' +
                '<select class="tmf-quick-round"><option value="0">Exact</option><option value="10">To $10</option><option value="100">To $100</option><option value="1000">To $1,000</option></select>' +
                '<label>Round direction</label>' +
                '<select class="tmf-quick-dir"><option value="nearest">Nearest</option><option value="down">Always down</option><option value="up">Always up</option></select>' +
                '<label>Save these as a preset</label>' +
                '<div class="tmf-quick-row"><input type="text" class="tmf-quick-name" placeholder="Preset name" maxlength="24" spellcheck="false" autocomplete="off"><button type="button" class="tmf-quick-btn tmf-quick-save">Save</button></div>' +
            '</div>';
        const formula = box.querySelector('.tmf-quick-formula');
        const note = box.querySelector('.tmf-quick-note');
        box.querySelector('.tmf-quick-toggle').addEventListener('click', function(event){
            event.stopPropagation();
            box.classList.toggle('tmf-quick--open');
            if (box.classList.contains('tmf-quick--open')) {
                refreshQuickChanges();
            }
        });
        // A click inside the panel must not count as a click on the bar's header.
        box.querySelector('.tmf-quick-panel').addEventListener('click', function(event){ event.stopPropagation(); });
        formula.addEventListener('input', function(){
            const problem = settingProblem(formula.value);
            formula.classList.toggle('tmf-quick-bad', problem != null);
            note.className = 'tmf-quick-note ' + (problem != null ? 'tmf-bad' : 'tmf-ok');
            note.textContent = problem != null ? problem : describeSetting(formula.value);
        });
        const presetSelect = box.querySelector('.tmf-quick-preset');
        const deleteButton = box.querySelector('.tmf-quick-del');
        // Editing any control by hand means the shown preset no longer describes the settings.
        function manualChange(){
            presetSelect.value = '';
            deleteButton.disabled = true;
            applyQuickChanges();
        }
        formula.addEventListener('change', manualChange);
        formula.addEventListener('keydown', function(event){
            event.stopPropagation();
            if (event.key === 'Enter') {
                formula.blur();
            }
        });
        presetSelect.addEventListener('change', function(event){
            const value = event.target.value;
            deleteButton.disabled = value.indexOf('my:') !== 0;
            if (value === '') {
                return;
            }
            if (value.indexOf('my:') === 0) {
                const preset = readCustomPresets()[parseInt(value.substring(3), 10)];
                if (preset != null) {
                    formula.value = preset.formula;
                    setQuickQuantity(preset.qty);
                    box.querySelector('.tmf-quick-round').value = String(preset.round);
                    box.querySelector('.tmf-quick-dir').value = preset.dir;
                    formula.dispatchEvent(new Event('input'));
                    applyQuickChanges();
                }
                return;
            }
            // A built-in preset only sets the formula, as it always has.
            formula.value = value;
            formula.dispatchEvent(new Event('input'));
            applyQuickChanges();
            event.target.value = '';
        });
        ['.tmf-quick-qty', '.tmf-quick-round', '.tmf-quick-dir'].forEach(function(selector){
            box.querySelector(selector).addEventListener('change', manualChange);
        });
        box.querySelector('.tmf-quick-name').addEventListener('keydown', function(event){
            event.stopPropagation();
            if (event.key === 'Enter') {
                saveQuickPreset();
            }
        });
        box.querySelector('.tmf-quick-save').addEventListener('click', saveQuickPreset);
        deleteButton.addEventListener('click', function(){
            const index = parseInt(presetSelect.value.substring(3), 10);
            const list = readCustomPresets();
            if (presetSelect.value.indexOf('my:') !== 0 || list[index] == null) {
                return;
            }
            const removed = list.splice(index, 1)[0];
            writeCustomPresets(list);
            refreshQuickChanges();
            quickNote('Deleted preset "' + removed.name + '".', true);
        });
        return box;
    }

    // Custom presets: a name plus the four quick settings, kept per page like everything else.
    const CUSTOM_PRESETS_KEY = isBazaarPage ? "freaky-market-helper-bazaar-custom-presets" : "freaky-market-helper-custom-presets";
    function readCustomPresets(){
        try {
            const parsed = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) ?? '[]');
            return Array.isArray(parsed) ? parsed.filter(function(item){
                return item != null && typeof item.name === 'string' && typeof item.formula === 'string';
            }).map(function(item){
                return {
                    name: item.name,
                    formula: item.formula,
                    qty: typeof item.qty === 'string' && item.qty !== '' ? item.qty : 'max',
                    round: ROUNDING_STEPS.indexOf(Number(item.round)) !== -1 ? Number(item.round) : 0,
                    dir: ROUNDING_DIRS.indexOf(item.dir) !== -1 ? item.dir : 'nearest'
                };
            }) : [];
        } catch (error) {
            return [];
        }
    }

    function writeCustomPresets(list){
        try {
            localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
        } catch (error) {
            console.warn('[FreakyMarketHelper] Could not store presets:', error);
        }
    }

    function quickNote(message, ok){
        const note = document.querySelector('.tmf-quick-note');
        if (note != null) {
            note.className = 'tmf-quick-note ' + (ok ? 'tmf-ok' : 'tmf-bad');
            note.textContent = message;
        }
    }

    // Quantity can be a value the dropdown does not list (a number, max-3): show it as "Custom".
    function setQuickQuantity(value){
        const qty = document.querySelector('.tmf-quick-qty');
        if (qty == null) {
            return;
        }
        Array.from(qty.querySelectorAll('.tmf-quick-custom')).forEach(function(option){ option.remove(); });
        if (!Array.from(qty.options).some(function(option){ return option.value === value; })) {
            const custom = document.createElement('option');
            custom.className = 'tmf-quick-custom';
            custom.value = value;
            custom.textContent = 'Custom: ' + value;
            qty.appendChild(custom);
        }
        qty.value = value;
    }

    function saveQuickPreset(){
        const box = document.querySelector('.tmf-quick');
        if (box == null) {
            return;
        }
        const nameInput = box.querySelector('.tmf-quick-name');
        const name = nameInput.value.trim();
        const formula = box.querySelector('.tmf-quick-formula').value.trim();
        if (name === '') {
            quickNote('Type a name for the preset first.', false);
            nameInput.focus();
            return;
        }
        const problem = settingProblem(formula);
        if (problem != null || formula === '') {
            quickNote(problem != null ? problem : 'Enter a price formula to save.', false);
            return;
        }
        const preset = {
            name: name,
            formula: formula,
            qty: box.querySelector('.tmf-quick-qty').value,
            round: Number(box.querySelector('.tmf-quick-round').value),
            dir: box.querySelector('.tmf-quick-dir').value
        };
        const list = readCustomPresets();
        const existing = list.findIndex(function(item){ return item.name.toLowerCase() === name.toLowerCase(); });
        if (existing !== -1) {
            list[existing] = preset;
        } else {
            list.push(preset);
        }
        writeCustomPresets(list);
        nameInput.value = '';
        refreshQuickChanges();
        const select = box.querySelector('.tmf-quick-preset');
        select.value = 'my:' + (existing !== -1 ? existing : list.length - 1);
        box.querySelector('.tmf-quick-del').disabled = false;
        quickNote((existing !== -1 ? 'Updated' : 'Saved') + ' preset "' + name + '".', true);
    }

    // Show the saved settings of this page in the quick panel.
    function refreshQuickChanges(){
        const box = document.querySelector('.tmf-quick');
        if (box == null) {
            return;
        }
        try {
            const profile = loadProfile(PAGE_PROFILE);
            const presets = isBazaarPage ? BAZAAR_PRESETS : PRICE_PRESETS;
            const mine = readCustomPresets();
            box.querySelector('.tmf-quick-preset').innerHTML = '<option value="">Choose a preset…</option>' +
                (mine.length > 0 ? '<optgroup label="My presets">' + mine.map(function(preset, index){
                    return '<option value="my:' + index + '">' + escapeHtml(preset.name) + '</option>';
                }).join('') + '</optgroup>' : '') +
                '<optgroup label="Built-in">' + presets.map(function(preset){
                    return '<option value="' + escapeHtml(preset.formula) + '">' + escapeHtml(preset.label) + '</option>';
                }).join('') + '</optgroup>';
            box.querySelector('.tmf-quick-del').disabled = true;
            const formula = box.querySelector('.tmf-quick-formula');
            formula.value = profile.delta;
            formula.dispatchEvent(new Event('input'));
            setQuickQuantity(profile.qty);
            box.querySelector('.tmf-quick-round').value = String(profile.round ?? 0);
            box.querySelector('.tmf-quick-dir').value = roundingDir;
        } catch (error) {
            console.warn('[FreakyMarketHelper] Quick changes could not load yet:', error);
        }
    }

    // Save whatever the quick panel shows. A formula that does not parse is left unsaved and
    // marked, so a typo can never reach the fill buttons.
    function applyQuickChanges(){
        const box = document.querySelector('.tmf-quick');
        if (box == null) {
            return;
        }
        const formula = box.querySelector('.tmf-quick-formula').value;
        if (settingProblem(formula) != null) {
            return;
        }
        const draft = profileToDraft(loadProfile(PAGE_PROFILE));
        draft.delta = formula;
        draft.qty = box.querySelector('.tmf-quick-qty').value;
        draft.round = Number(box.querySelector('.tmf-quick-round').value);
        draft.roundDir = box.querySelector('.tmf-quick-dir').value;
        saveProfileDraft(PAGE_PROFILE, draft);
        const note = box.querySelector('.tmf-quick-note');
        note.className = 'tmf-quick-note tmf-ok';
        note.textContent = 'Saved. ' + describeSetting(draft.delta.trim() === '' ? PROFILE_DEFAULT_DELTA[PAGE_PROFILE] : draft.delta);
    }

    function ensureFillAllUI(){
        let bar = document.querySelector(".tmf-fillall-bar");
        if (bar == null) {
            bar = document.createElement('div');
            bar.className = 'tmf-fillall-bar';
            const grip = document.createElement('span');
            grip.className = 'tmf-fillall-grip';
            grip.textContent = '⠿';
            grip.title = 'Drag to move; drop near an edge to minimise';
            const head = document.createElement('div');
            head.className = 'tmf-fillall-head';
            head.title = 'Click to open or close';
            const body = document.createElement('div');
            body.className = 'tmf-fillall-body';
            // Second way into the settings, next to the always-visible Fill All button —
            // the press-and-hold on a row's fill button remains available too.
            const cog = document.createElement('span');
            cog.className = 'tmf-fillall-cog';
            cog.innerHTML = '<span class="tmf-cog-icon">⚙</span><span class="tmf-cog-label">Settings</span>';
            cog.title = 'Open Freaky Market Helper settings';
            const btn = document.createElement('input');
            btn.type = 'button';
            btn.className = 'torn-btn tmf-fillall-btn';
            const dot = document.createElement('span');
            dot.className = 'tmf-autofill-dot';
            const report = document.createElement('span');
            report.className = 'tmf-fillall-report';
            report.title = 'Session receipt: what you have listed and what it is worth';
            report.innerHTML = '<span class="tmf-report-icon">&#129534;</span><span class="tmf-report-label">Session receipt</span><span class="tmf-report-count"></span>';
            if (isBazaarPage){
                const dollar = document.createElement('span');
                dollar.className = 'tmf-fillall-dollar';
                dollar.textContent = '$1 Dollar bazaar';
                dollar.title = 'Dollar bazaar: list everything for $1';
                dollar.classList.toggle('tmf-fillall-dollar--on', dollarBazaar);
                dollar.addEventListener('click', function(event){
                    event.stopPropagation();
                    dollarBazaar = !dollarBazaar;
                    try {
                        localStorage.setItem(DOLLAR_BAZAAR_KEY, dollarBazaar ? '1' : '0');
                    } catch (error) {
                        // Blocked storage: the mode still holds until the page reloads.
                    }
                    dollar.classList.toggle('tmf-fillall-dollar--on', dollarBazaar);
                    showToast(dollarBazaar ? 'Dollar bazaar ON: fills list at $1.' : 'Dollar bazaar off: normal pricing.');
                });
                body.append(btn, report, cog, dollar);
            } else {
                body.append(btn, report, cog);
            }
            body.append(buildQuickChanges());
            const title = document.createElement('span');
            title.className = 'tmf-fillall-title';
            title.textContent = 'Freaky Market Helper';
            const chev = document.createElement('span');
            chev.className = 'tmf-fillall-chev';
            chev.textContent = '▼';
            head.append(grip, title, dot, chev);
            bar.append(head, body);
            report.addEventListener('click', function(event){
                event.stopPropagation();
                openReportModal();
            });
            cog.addEventListener('click', function(event){
                event.stopPropagation();
                openSettingsModal();
            });
            btn.addEventListener('click', function(event){
                event.stopPropagation();
                if (autoFillActive) {
                    stopAutoFill();
                } else {
                    startAutoFill();
                }
            });
            document.body.appendChild(bar);
            attachFillAllDrag(bar);
            applyFillAllState(bar);
        }
        if (document.querySelector(".tmf-viewport-border") == null) {
            const border = document.createElement('div');
            border.className = 'tmf-viewport-border';
            document.body.appendChild(border);
        }
        applyChatRelativeZIndex();
        updateAutoFillUI();
        updateReportBadge();
    }

    // Torn's chat is a body-level overlay anchored bottom-right. Read its z-index and
    // drop our floating UI just below it so an open chat window is never overshadowed.
    function detectChatZIndex(){
        let el = document.querySelector("#chatRoot");
        while (el && el !== document.body) {
            let z = parseInt(window.getComputedStyle(el).zIndex, 10);
            if (!isNaN(z)) {
                return z;
            }
            el = el.parentElement;
        }
        return null;
    }

    function applyChatRelativeZIndex(){
        let bar = document.querySelector(".tmf-fillall-bar");
        if (bar == null) {
            return;
        }
        if (chatRelativeZBase == null) {
            let chatZ = detectChatZIndex();
            if (chatZ == null) {
                // Chat may not have mounted yet; retry shortly without blocking, but give up
                // eventually — a page that never mounts the chat must not be polled forever.
                if (chatZRetries++ < CHAT_Z_MAX_RETRIES) {
                    setTimeout(applyChatRelativeZIndex, 1500);
                }
                return;
            }
            chatRelativeZBase = Math.max(chatZ - 1, 1);
        }
        bar.style.zIndex = chatRelativeZBase;
        let border = document.querySelector(".tmf-viewport-border");
        if (border != null) {
            border.style.zIndex = Math.max(chatRelativeZBase - 1, 1);
        }
        let toast = document.querySelector(".tmf-toast");
        if (toast != null) {
            toast.style.zIndex = chatRelativeZBase;
        }
    }

    function updateAutoFillUI(){
        let bar = document.querySelector(".tmf-fillall-bar");
        if (bar != null) {
            bar.querySelector(".tmf-fillall-btn").value = autoFillActive ? "Stop" : "Fill All ★";
            bar.classList.toggle("tmf-fillall-bar--active", autoFillActive);
        }
        let border = document.querySelector(".tmf-viewport-border");
        if (border != null) {
            border.classList.toggle("tmf-viewport-border--active", autoFillActive);
        }
    }

    function showToast(message){
        let toast = document.querySelector('.tmf-toast');
        if (toast == null){
            toast = document.createElement('div');
            toast.className = 'tmf-toast';
            document.body.appendChild(toast);
            if (chatRelativeZBase != null) {
                toast.style.zIndex = chatRelativeZBase;
            }
        }
        toast.textContent = message;
        toast.classList.add('tmf-toast--visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function(){
            toast.classList.remove('tmf-toast--visible');
        }, 4000);
    }

    function startAutoFill(){
        if (favourites.size === 0){
            showToast('No favourites set yet — tap the ☆ star next to an item first, then use Fill All.');
            return;
        }
        checkApiKey();
        if (needsTornApiKey() && !hasUsableApiKey()){
            showToast('A public Torn API key is needed for this price source. Add one in the settings (⚙).');
            return;
        }
        autoFillActive = true;
        autoFillQueue = [];
        autoFillQueuedIds = new Set();
        autoFillDoneIds = new Set();
        autoFillRetries = new Map();
        updateAutoFillUI();
        enqueueVisibleFavourites();
        runAutoFillLoop();
    }

    function stopAutoFill(){
        autoFillActive = false;
        autoFillQueue = [];
        autoFillQueuedIds.clear();
        updateAutoFillUI();
    }

    function enqueueVisibleFavourites(){
        document.querySelectorAll(".fmh-processed[data-tmf-item-id]").forEach(enqueueFavouriteRow);
    }

    function enqueueFavouriteRow(wrapper){
        if (!autoFillActive) {
            return;
        }
        let itemId = parseInt(wrapper.dataset.tmfItemId, 10);
        if (!favourites.has(itemId) || excluded.has(itemId) || autoFillDoneIds.has(itemId) || autoFillQueuedIds.has(itemId)) {
            return;
        }
        autoFillQueuedIds.add(itemId);
        autoFillQueue.push(wrapper);
        runAutoFillLoop();
    }

    async function runAutoFillLoop(){
        if (autoFillLoopRunning) {
            return;
        }
        autoFillLoopRunning = true;
        try {
            while (autoFillActive && autoFillQueue.length > 0) {
                let wrapper = autoFillQueue.shift();
                let itemId = parseInt(wrapper.dataset.tmfItemId, 10);
                if (!wrapper.isConnected || !favourites.has(itemId) || excluded.has(itemId)) {
                    // Row unmounted or unfavourited meanwhile; the observer re-queues it
                    // if it shows up again.
                    autoFillQueuedIds.delete(itemId);
                    continue;
                }
                let fillBtn = wrapper.querySelector(".fmh-button");
                if (fillBtn == null || fillBtn.getAttribute('data-action-flag') !== 'fill') {
                    // Already filled (button is in "clear" state) — count as done.
                    autoFillQueuedIds.delete(itemId);
                    autoFillDoneIds.add(itemId);
                    continue;
                }
                let status;
                try {
                    status = await performFill(fillBtn, itemId, false);
                } catch (error) {
                    // A single row with unexpected DOM must not abort the whole run.
                    console.error("[FreakyMarketHelper] Fill All failed for item " + itemId + ":", error);
                    status = "error";
                }
                if (status === "rate-limited") {
                    let attempts = (autoFillRetries.get(itemId) ?? 0) + 1;
                    autoFillRetries.set(itemId, attempts);
                    if (attempts <= MAX_RATE_LIMIT_RETRIES) {
                        autoFillQueue.unshift(wrapper); // retry the same row after the pause
                        await sleep(randomBetween(RATE_LIMIT_PAUSE_MIN_MS, RATE_LIMIT_PAUSE_MAX_MS));
                        continue;
                    }
                    console.warn("[FreakyMarketHelper] Fill All giving up on item " + itemId + " after repeated rate limits.");
                }
                if (status === "invalid-key") {
                    console.error("[FreakyMarketHelper] Stopping Fill All: API key is invalid.");
                    stopAutoFill();
                    break;
                }
                autoFillQueuedIds.delete(itemId);
                autoFillDoneIds.add(itemId);
                if (status !== "ok" && status !== "skipped") {
                    console.warn("[FreakyMarketHelper] Fill All skipped item " + itemId + " after error.");
                }
                await sleep(randomBetween(FILL_COOLDOWN_MIN_MS, FILL_COOLDOWN_MAX_MS));
            }
        } finally {
            autoFillLoopRunning = false;
        }
        // Rows enqueued while the loop was winding down (e.g. during the last cooldown)
        if (autoFillActive && autoFillQueue.length > 0) {
            runAutoFillLoop();
        }
    }

    function sleep(ms){
        return new Promise(function(resolve){ setTimeout(resolve, ms); });
    }

    function randomBetween(min, max){
        return min + Math.random() * (max - min);
    }

    function loadCategoryDeltas(){
        try {
            let parsed = JSON.parse(localStorage.getItem(categoryDeltasKey) ?? "{}");
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (error) {
            console.error("[FreakyMarketHelper] Failed to load category deltas:", error);
            return {};
        }
    }

    function saveCategoryDeltas(){
        localStorage.setItem(categoryDeltasKey, JSON.stringify(categoryDeltas));
    }

    function loadCategoryQuantities(){
        try {
            let parsed = JSON.parse(localStorage.getItem(categoryQuantitiesKey) ?? "{}");
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (error) {
            console.error("[FreakyMarketHelper] Failed to load category quantities:", error);
            return {};
        }
    }

    function saveCategoryQuantities(){
        localStorage.setItem(categoryQuantitiesKey, JSON.stringify(categoryQuantities));
    }

    function loadItemCategoryCache(){
        try {
            let parsed = JSON.parse(localStorage.getItem(itemCategoryCacheKey) ?? "{}");
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    // Returns the cached {type, ts} for an item, normalising legacy bare-string entries
    // (which predate timestamps) to an immediately-stale ts so they get re-verified.
    function getCachedCategory(itemId){
        let entry = itemCategoryCache[itemId];
        if (entry == null){
            return null;
        }
        if (typeof entry === 'string'){
            return { type: entry, ts: 0 };
        }
        if (typeof entry === 'object' && typeof entry.type === 'string'){
            return { type: entry.type, ts: typeof entry.ts === 'number' ? entry.ts : 0 };
        }
        return null;
    }

    function cacheItemCategory(itemId, type){
        itemCategoryCache[itemId] = { type: type, ts: Date.now() };
        try {
            localStorage.setItem(itemCategoryCacheKey, JSON.stringify(itemCategoryCache));
        } catch (error) {
            // Ignore storage quota errors; the in-memory cache still helps this session.
        }
    }

    function clearItemCategoryCache(){
        itemCategoryCache = {};
        try {
            localStorage.removeItem(itemCategoryCacheKey);
        } catch (error) {
            // Ignore storage errors; the in-memory cache is cleared regardless.
        }
    }

    // ---- Bazaar page ---------------------------------------------------------------------------
    // Click (focus) a price box and it fills in the price; click an amount box and it fills in how
    // many you own. Works on both Add Items and Manage Items. Prices come from the same formula
    // engine as the Item Market, with their own setting (bazaarDeltaRaw).

    // Set an input's value in a way React notices: the native setter, a reset of React's value
    // tracker, then a bubbling input event.
    function setReactValue(input, value){
        let setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (setter != null && setter.set != null){
            setter.set.call(input, value);
        } else {
            input.value = value;
        }
        if (input._valueTracker != null){
            input._valueTracker.setValue('');
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('keyup', { bubbles: true }));
    }

    // The nearest ancestor that holds an item image, which is the row the input belongs to.
    function findItemRow(input){
        let el = input.parentElement;
        for (let depth = 0; el != null && depth < 10; depth++, el = el.parentElement){
            let img = el.querySelector('img[src*="items/"]');
            if (img != null){
                let match = img.src.match(/items\/(\d+)\//);
                if (match != null){
                    // The image and the price box can sit in different cells; widen the row until
                    // it also holds the amount box, without ever swallowing a neighbouring row.
                    let row = el;
                    for (let up = 0; up < 4 && row.querySelector('.amount .clear-all:not([type=hidden])') == null && row.parentElement != null
                         && row.parentElement.querySelectorAll('.input-money:not([type=hidden])').length === 1; up++){
                        row = row.parentElement;
                    }
                    return { row: row, itemId: parseInt(match[1], 10) };
                }
            }
        }
        return null;
    }

    function bazaarNeedsKey(){
        return formulaBranches(bazaarDeltaRaw).some(function(branch){
            return sourceOf(branch) !== SOURCE_BAZAAR;
        });
    }

    // The price a bazaar click would set, or null (after saying why) when there isn't one.
    async function bazaarPriceFor(itemId){
        if (dollarBazaar){
            return 1;
        }
        if (bazaarNeedsKey() && !hasUsableApiKey()){
            showToast('A public Torn API key is needed for this price source. Add one in the settings.');
            return null;
        }
        try {
            let pricing = await priceSetting(bazaarDeltaRaw, itemId, null, null);
            if (getPricesStatus(pricing.prices) !== 'ok'){
                showToast(pricing.prices != null && pricing.prices.price != null ? String(pricing.prices.price) : 'Could not price this item.');
                return null;
            }
            return GetPrice(pricing.prices, pricing.formula);
        } catch (error) {
            console.error("[FreakyMarketHelper] Bazaar price failed for item " + itemId + ":", error);
            showToast('Failed!');
            return null;
        }
    }

    // True once a Fill (button, select box or Fill All) has set this row, so a later click on the
    // box does not overwrite it.
    function rowIsFilled(row){
        let button = row.querySelector('.fmh-button');
        return button != null && button.getAttribute('data-action-flag') === 'clear';
    }

    async function onBazaarPriceFocus(input, itemId, row){
        if (input.dataset.tmfBazaar === 'busy' || input.dataset.tmfBazaar === 'done' || (row != null && rowIsFilled(row))){
            return;
        }
        input.dataset.tmfBazaar = 'busy';
        let price = await bazaarPriceFor(itemId);
        if (price != null){
            setReactValue(input, price);
            input.dataset.tmfBazaar = 'done';
        } else {
            input.dataset.tmfBazaar = '1'; // nothing was set, so the next click tries again
        }
    }

    // How many of the item the row shows ("x5"); a row with no count is a single item.
    function readBazaarInventory(row){
        let label = row.querySelector('.name-wrap .t-hide') ?? row.querySelector('[class*=name] .t-hide');
        let text = label != null ? label.textContent : '';
        if (text.trim() === ''){
            return 1;
        }
        let parsed = parseInt(text.replace(/[^\d]/g, ''), 10);
        return !isNaN(parsed) && parsed > 0 ? parsed : 1;
    }

    function onBazaarAmountFocus(input, row){
        if (input.dataset.tmfBazaarAmount === 'done' || rowIsFilled(row)){
            return;
        }
        let amount = resolveQuantity(readBazaarInventory(row), getEffectiveQuantity(null));
        if (amount === null){
            return; // the quantity setting says to keep these
        }
        setReactValue(input, amount);
        input.dataset.tmfBazaarAmount = 'done';
    }

    // Add Items and Manage rows on the bazaar get the same Fill button, select box and star as the Item Market.
    function scanBazaarRows(root){
        root.querySelectorAll('.input-money:not([type=hidden])').forEach(function(input){
            if (input.closest('[class*=removeAmountInput]') != null){
                return;
            }
            let group = input.closest('.input-money-group');
            let found = findItemRow(input);
            if (group == null || found == null){
                return;
            }
            found.row.classList.add('tmf-bz-row');
            AddFillButton(group.parentElement ?? group);
        });
    }

    // The bazaar's amount box is plain text and Torn does not clamp it for us, so the exact count
    // comes from the row's own "xN" label.
    function applyBazaarQuantity(row, inputs, action, mode, isAuto){
        if (inputs.length === 0){
            return 'ok';
        }
        let hasUserAmount = inputs[0].value.length !== 0 && parseInt(inputs[0].value) >= 1;
        if (action == 'clear'){
            setQuantityInputs(inputs, '');
            return 'ok';
        }
        if (hasUserAmount){
            return 'ok'; // an amount you typed yourself wins over any quantity mode
        }
        let inventory = readBazaarInventory(row);
        let resolved = resolveQuantity(inventory, mode);
        if (resolved === null){
            setQuantityInputs(inputs, '');
            reportSkipped(mode, inventory, isAuto);
            return 'skipped';
        }
        setQuantityInputs(inputs, resolved);
        return 'ok';
    }

    function scanBazaarInputs(root){
        root.querySelectorAll('.input-money:not([type=hidden])').forEach(function(input){
            if (input.dataset.tmfBazaar != null || input.closest('[class*=removeAmountInput]') != null){
                return;
            }
            let found = findItemRow(input);
            if (found == null){
                return;
            }
            input.dataset.tmfBazaar = '1';
            input.addEventListener('focus', function(){ onBazaarPriceFocus(input, found.itemId, found.row); });
            let amountInput = found.row.querySelector('.amount .clear-all:not([type=hidden])');
            if (amountInput != null && amountInput.dataset.tmfBazaarAmountBound == null){
                amountInput.dataset.tmfBazaarAmountBound = '1';
                amountInput.addEventListener('focus', function(){ onBazaarAmountFocus(amountInput, found.row); });
            }
        });
    }

    function initBazaarAutoPrice(){
        // Falls back to the body so the scan still runs if the root is renamed or not mounted yet.
        let root = document.querySelector('#bazaarRoot') ?? document.body;
        let scheduled = false;
        let scan = function(){
            scheduled = false;
            scanBazaarInputs(root);
        };
        new MutationObserver(function(){
            if (!scheduled){
                scheduled = true;
                requestAnimationFrame(scan);
            }
        }).observe(root, { childList: true, subtree: true });
        scan();
    }

    // ---- Session receipt ---------------------------------------------------------------------
    // Every successful fill on Add Items is written to a ledger, and the receipt adds it up. The
    // script cannot know what you paid for an item, so "profit/loss" is measured against each
    // item's market reference (the average sale price, or Torn's market value) — the question
    // answered is "am I listing above or below the market, after tax?".
    function loadSession(){
        try {
            let parsed = JSON.parse(localStorage.getItem(sessionKey) ?? "null");
            if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object'){
                return parsed;
            }
        } catch (error) {
            // A corrupt ledger just starts over.
        }
        return { start: Date.now(), items: {} };
    }

    function saveSession(){
        try {
            localStorage.setItem(sessionKey, JSON.stringify(session));
        } catch (error) {
            // Quota or blocked storage: the in-memory ledger still serves this page load.
        }
        updateReportBadge();
    }

    function updateReportBadge(){
        let count = Object.keys(session.items).length;
        document.querySelectorAll('.tmf-report-count').forEach(function(el){
            el.textContent = count > 0 ? String(count) : '';
        });
    }

    function removeListing(itemId){
        let id = parseInt(itemId, 10);
        if (session.items[id] != null){
            delete session.items[id];
            saveSession();
        }
    }

    function readRowName(wrapper, itemId){
        let nameWrap = wrapper != null ? wrapper.querySelector('.name-wrap') : null;
        if (nameWrap != null){
            // The bazaar row's name box also holds the "xN" count; leave that out.
            // The row's name box repeats the count ("x3") around the name; the name itself has its own span.
            let nameSpan = nameWrap.querySelector('.t-overflow');
            if (nameSpan != null && nameSpan.textContent.trim() !== ''){
                return nameSpan.textContent.trim();
            }
            let copy = nameWrap.cloneNode(true);
            copy.querySelectorAll('.t-hide').forEach(function(el){ el.remove(); });
            let named = copy.textContent.trim();
            if (named !== ''){
                return named;
            }
        }
        let nameEl = wrapper != null ? (wrapper.querySelector('[class*=itemName___]') ?? wrapper.querySelector('[class*=name___]')) : null;
        let text = nameEl != null ? nameEl.textContent.trim() : '';
        if (text === '' && wrapper != null){
            let img = wrapper.querySelector('img[alt]');
            text = img != null ? (img.getAttribute('alt') ?? '').trim() : '';
        }
        return text !== '' ? text : 'Item #' + itemId;
    }

    // How many units the row is now set to list. Torn clamps an over-large amount to what you own
    // a moment after the input event, so the read waits a frame; if the value still looks
    // unclamped, the row's own "xN" count is used, and a single-copy row is 1 by definition.
    async function readListedQuantity(target){
        let parentRow = findInfoRow(target);
        if (parentRow == null){
            return 1;
        }
        let input = rowAmountInputs(parentRow)[0] ?? null;
        if (input == null){
            return 1;
        }
        await nextFrame();
        let value = parseInt(String(input.value).replace(/[^\d]/g, ''), 10);
        if (!isNaN(value) && value > 0 && value < 1e9){
            return value;
        }
        let match = String(parentRow.textContent).match(/\bx\s?(\d[\d,]*)/i);
        let parsed = match != null ? parseInt(match[1].replace(/,/g, ''), 10) : NaN;
        return !isNaN(parsed) && parsed > 0 ? parsed : 1;
    }

    async function recordListing(target, itemId, price, fill){
        let id = parseInt(itemId, 10);
        if (isNaN(id) || id <= 0){
            return;
        }
        let wrapper = findRowWrapper(target);
        let reference = null;
        let referenceLabel = null;
        if (fill != null){
            if (fill.average != null){
                reference = fill.average;
                referenceLabel = 'Average sale price';
            } else if (fill.label === 'Average sale price' || fill.label === 'Market value'){
                reference = fill.base;
                referenceLabel = fill.label;
            }
        }
        session.items[id] = {
            id: id,
            name: readRowName(wrapper, id),
            quantity: await readListedQuantity(target),
            price: price,
            reference: reference,
            referenceLabel: referenceLabel,
            taxFactor: marketTaxFactor,
            ts: Date.now()
        };
        saveSession();
    }

    function money(value){
        return '$' + formatNumberWithCommas(Math.round(value));
    }

    function signedMoney(value){
        return (value < 0 ? '-' : '+') + money(Math.abs(value));
    }

    // Totals over the whole ledger. Items with no market reference (a bazaar-only price, say)
    // count towards the listed totals but stay out of the market comparison.
    function sessionTotals(){
        let totals = { items: 0, units: 0, listed: 0, net: 0, refItems: 0, refUnits: 0, refValue: 0, refNet: 0 };
        Object.values(session.items).forEach(function(entry){
            let line = entry.quantity * entry.price;
            totals.items += 1;
            totals.units += entry.quantity;
            totals.listed += line;
            let factor = entry.taxFactor ?? 0.95;
            totals.net += line * factor;
            if (entry.reference != null){
                totals.refItems += 1;
                totals.refUnits += entry.quantity;
                totals.refValue += entry.quantity * entry.reference;
                totals.refNet += line * factor;
            }
        });
        totals.diff = totals.refNet - totals.refValue;
        return totals;
    }

    // "-$2 (-0.3%)": the dollar figure is rounded for display, so the percentage is what shows
    // how small a gap really is.
    function diffLabel(totals){
        let pct = totals.refValue > 0 ? (totals.diff / totals.refValue) * 100 : 0;
        return signedMoney(totals.diff) + ' (' + (pct < 0 ? '' : '+') + pct.toFixed(1) + '%)';
    }

    function receiptText(){
        let entries = Object.values(session.items).sort(function(a, b){ return a.ts - b.ts; });
        let totals = sessionTotals();
        let lines = ['Freaky Market Helper receipt', new Date(session.start).toLocaleString() + ' - now', ''];
        entries.forEach(function(e){
            lines.push(e.name + ': ' + e.quantity + ' x ' + money(e.price) + ' = ' + money(e.quantity * e.price));
        });
        lines.push('', 'Items: ' + totals.items + '  Units: ' + formatNumberWithCommas(totals.units),
                   'Listed total: ' + money(totals.listed), 'After tax: ' + money(totals.net));
        if (totals.refItems > 0){
            lines.push('Market reference: ' + money(totals.refValue), 'Net vs market: ' + diffLabel(totals));
        }
        return lines.join('\n');
    }

    function renderReceipt(){
        let entries = Object.values(session.items).sort(function(a, b){ return a.ts - b.ts; });
        if (entries.length === 0){
            return '<div class="tmf-receipt tmf-receipt-empty">Nothing listed yet this session.<br>Fill or tick an item on Add Items and it shows up here.</div>';
        }
        let totals = sessionTotals();
        let html = '<div class="tmf-receipt">';
        entries.forEach(function(e){
            html += '<div class="tmf-receipt-line"><span class="tmf-rname">' + escapeHtml(e.name) + '</span><span>' + money(e.quantity * e.price) + '</span></div>' +
                    '<div class="tmf-receipt-line tmf-rsub"><span>' + formatNumberWithCommas(e.quantity) + ' &times; ' + money(e.price) + '</span><span>' +
                    (e.reference != null ? 'mkt ' + money(e.reference) : 'no market ref') + '</span></div>';
        });
        html += '<hr class="tmf-receipt-rule">' +
                '<div class="tmf-receipt-line"><span>Items / units</span><span>' + totals.items + ' / ' + formatNumberWithCommas(totals.units) + '</span></div>' +
                '<div class="tmf-receipt-line tmf-receipt-total"><span>Listed total</span><span>' + money(totals.listed) + '</span></div>' +
                '<div class="tmf-receipt-line"><span>After tax</span><span>' + money(totals.net) + '</span></div>';
        if (totals.refItems > 0){
            html += '<hr class="tmf-receipt-rule">' +
                    '<div class="tmf-receipt-line"><span>Market reference' + (totals.refItems < totals.items ? ' (' + totals.refItems + ' of ' + totals.items + ')' : '') + '</span><span>' + money(totals.refValue) + '</span></div>' +
                    '<div class="tmf-receipt-line ' + (totals.diff >= 0 ? 'tmf-receipt-gain' : 'tmf-receipt-loss') + '"><span>Net vs market</span><span>' + diffLabel(totals) + '</span></div>';
        }
        html += '</div><div class="tmf-receipt-note">Your purchase cost is not known to the script, so profit/loss is measured against each item&rsquo;s market reference (average sale price, or Torn market value), after tax (5% on the Item Market, none on the bazaar). Positive means you are listing above the market. The 5% tax comes off the higher selling price, so breaking even takes about +5.3% over the reference, not +5%.</div>';
        return html;
    }

    function openReportModal(){
        let overlay = document.querySelector('.tmf-report-overlay');
        if (overlay == null){
            overlay = document.createElement('div');
            overlay.className = 'tmf-modal-overlay tmf-report-overlay';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', function(event){
                if (event.target === overlay || event.target.classList.contains('tmf-modal-close')){
                    overlay.classList.remove('tmf-modal-overlay--open');
                } else if (event.target.classList.contains('tmf-report-reset')){
                    session = { start: Date.now(), items: {} };
                    saveSession();
                    openReportModal();
                } else if (event.target.classList.contains('tmf-report-copy')){
                    let text = receiptText();
                    let done = function(){ showToast('Receipt copied.'); };
                    try {
                        navigator.clipboard.writeText(text).then(done, function(){ showToast('Could not copy the receipt.'); });
                    } catch (error) {
                        showToast('Could not copy the receipt.');
                    }
                }
            });
        }
        overlay.innerHTML =
            '<div class="tmf-modal">' +
                '<h3>Session receipt<span class="tmf-modal-close" title="Close">&times;</span></h3>' +
                '<p class="tmf-modal-sub">Since ' + escapeHtml(new Date(session.start).toLocaleString()) + '</p>' +
                renderReceipt() +
                '<div class="tmf-modal-actions">' +
                    '<button type="button" class="tmf-report-reset">New session</button>' +
                    '<button type="button" class="tmf-report-copy">Copy</button>' +
                    '<button type="button" class="tmf-modal-cancel tmf-modal-close">Close</button>' +
                '</div>' +
            '</div>';
        overlay.classList.add('tmf-modal-overlay--open');
    }

    // ---- "What's new" popup ----------------------------------------------------------------

    function compareVersions(left, right){
        let leftParts = String(left).split('.').map(function(part){ return parseInt(part, 10) || 0; });
        let rightParts = String(right).split('.').map(function(part){ return parseInt(part, 10) || 0; });
        for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++){
            let difference = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
            if (difference !== 0){
                return difference < 0 ? -1 : 1;
            }
        }
        return 0;
    }

    function maybeShowChangelog(){
        let lastSeen;
        try {
            lastSeen = localStorage.getItem(lastSeenVersionKey);
        } catch (error) {
            return;
        }
        if (lastSeen === SCRIPT_VERSION){
            return;
        }
        // No stored version means one of two things: a brand-new install, or — far more often,
        // because this is the first release to carry the popup — a long-standing user whose key
        // simply never existed. The two are indistinguishable from here, so the notes get shown
        // rather than swallowed. Staying silent would hide this release from everyone who
        // already had the script.
        let unseen = lastSeen == null
            ? CHANGELOG
            : CHANGELOG.filter(function(release){ return compareVersions(release.version, lastSeen) > 0; });
        // Silent releases wait for the menu: they never open the popup, and stay out of it when
        // another release does.
        unseen = unseen.filter(function(release){ return !release.silent; });
        if (unseen.length === 0){
            rememberChangelogSeen();
            return;
        }
        openChangelogModal(unseen);
    }

    function rememberChangelogSeen(){
        try {
            localStorage.setItem(lastSeenVersionKey, SCRIPT_VERSION);
        } catch (error) {
            // A blocked localStorage only means the popup returns on the next page load.
        }
    }

    // Entries are literals defined in this file, so their inline markup is intentional.
    function renderChangelogRelease(release, index){
        return '<div class="tmf-changelog-release">' +
                   '<div class="tmf-changelog-ver"><b>v' + release.version + '</b>' +
                       (index === 0 ? '<span class="tmf-changelog-badge">new</span>' : '') +
                       '<span class="tmf-changelog-date">' + release.date + '</span>' +
                   '</div>' +
                   '<ul class="tmf-changelog-items">' +
                       release.changes.map(function(change){ return '<li>' + change + '</li>'; }).join('') +
                   '</ul>' +
               '</div>';
    }

    function openChangelogModal(releases){
        if (releases.length === 0){
            return;
        }
        let overlay = document.querySelector('.tmf-changelog-overlay');
        if (overlay == null){
            overlay = document.createElement('div');
            // Borrows the settings modal's chrome, so the popup needs no layout of its own.
            overlay.className = 'tmf-modal-overlay tmf-changelog-overlay';
            document.body.appendChild(overlay);
        }
        overlay.innerHTML =
            '<div class="tmf-modal">' +
                '<h3>Freaky Market Helper v' + SCRIPT_VERSION + ' — what&rsquo;s new' +
                    '<span class="tmf-modal-close" title="Close">&times;</span>' +
                '</h3>' +
                releases.map(renderChangelogRelease).join('') +
                '<div class="tmf-modal-actions">' +
                    '<button type="button" class="tmf-changelog-settings">Open settings</button>' +
                    '<button type="button" class="tmf-modal-save tmf-changelog-ok">Got it</button>' +
                '</div>' +
            '</div>';

        overlay.querySelector('.tmf-modal-close').addEventListener('click', closeChangelogModal);
        overlay.querySelector('.tmf-changelog-ok').addEventListener('click', closeChangelogModal);
        overlay.querySelector('.tmf-changelog-settings').addEventListener('click', function(){
            closeChangelogModal();
            openSettingsModal();
        });
        overlay.addEventListener('click', function(event){ if (event.target === overlay){ closeChangelogModal(); } });
        overlay.classList.add('tmf-modal-overlay--open');
    }

    // Dismissing by any route counts as read — the popup must never nag.
    function closeChangelogModal(){
        let overlay = document.querySelector('.tmf-changelog-overlay');
        if (overlay != null){
            overlay.classList.remove('tmf-modal-overlay--open');
        }
        rememberChangelogSeen();
    }

    // One-click starting points for the price field. The point of each is the plain-words name.
    const PRICE_PRESETS = [
        { label: 'Undercut cheapest', formula: '-1[0]', hint: 'Cheapest listing minus $1 (default)' },
        { label: '5% above avg price', formula: '+5%[avg]', hint: 'Average sale price from the item market, plus 5%' },
        { label: '5% above market value', formula: '+5%[market]', hint: "Torn's market-value figure, plus 5%" },
        { label: 'Break even (avg)', formula: '+5.27%[avg]', hint: 'Average sale price plus 5.27%: after the 5% fee you net just over the average' },
        { label: 'Break even (market value)', formula: '+5.27%[market]', hint: "Torn's market value plus 5.27%: after the 5% fee you net just over it" },
        { label: 'Match median', formula: '[median]', hint: 'Median listing, no discount' },
        { label: 'Undercut bazaars', formula: '-1[bazaar]', hint: 'Cheapest bazaar minus $1' }
    ];

    // The formula in plain words, shown live under the field.
    function describeSetting(setting){
        let raw = String(setting ?? '').trim();
        if (raw === ''){
            return 'Blank: uses the default, cheapest listing minus $1.';
        }
        let root = parseSetting(raw);
        if (root.kind !== 'formula'){
            return 'Combination of ' + collectFormulas(root).length + ' formulas: the ' + (root.combine === 'min' ? 'lowest' : 'highest') + ' price wins.';
        }
        let formula = root.formula;
        let token = bracketToken(formula);
        let base = token === 'market' ? "Torn's market value"
            : isAverageFormula(formula) ? 'the average sale price'
            : isMedianFormula(formula) ? (token.indexOf('bazaar') === 0 ? 'the median bazaar listing' : 'the median listing')
            : sourceOf(formula) === SOURCE_BAZAAR ? (bazaarSelector(formula).kind === 'avg' ? 'the bazaar average' : (bazaarSelector(formula).index === 0 ? 'the cheapest bazaar listing' : 'bazaar listing #' + (bazaarSelector(formula).index + 1)))
            : (listingSlot(formula) === 0 ? 'the cheapest listing' : 'listing #' + (listingSlot(formula) + 1));
        let match = stripDeltaBracket(formula).match(/^([-+]?)(\d+(?:\.\d+)?)(%?)$/);
        if (match == null){
            return 'Price = ' + base + '.';
        }
        let amount = match[3] ? match[2] + '%' : '$' + match[2];
        return 'Price = ' + amount + (match[1] === '-' ? ' below ' : ' above ') + base + '.';
    }

    function ensureSettingsModal(){
        if (document.querySelector('.tmf-settings-overlay') != null){
            return;
        }
        const overlay = document.createElement('div');
        overlay.className = 'tmf-modal-overlay tmf-settings-overlay';
        overlay.innerHTML =
            '<div class="tmf-modal">' +
                '<h3>Freaky Market Helper<span class="tmf-modal-close" title="Close">&times;</span></h3>' +
                '<div class="tmf-tabs">' +
                    '<span class="tmf-tab" data-profile="market">Item Market</span>' +
                    '<span class="tmf-tab" data-profile="bazaar">Bazaar</span>' +
                '</div>' +
                '<p class="tmf-modal-sub tmf-modal-profile-sub"></p>' +
                '<div class="tmf-modal-section">' +
                    '<h4>Pricing</h4>' +
                    '<div class="tmf-chips tmf-price-chips"></div>' +
                    '<input type="text" class="tmf-modal-delta" placeholder="-1[0]" spellcheck="false" autocomplete="off">' +
                    '<div class="tmf-modal-live"></div>' +
                    '<label>Quantity</label>' +
                    '<input type="text" class="tmf-modal-qty" placeholder="max" spellcheck="false" autocomplete="off">' +
                    '<div class="tmf-chips" style="margin-top:6px">' +
                        '<span class="tmf-chip" data-qty="max">All</span>' +
                        '<span class="tmf-chip" data-qty="max-1">Keep 1</span>' +
                        '<span class="tmf-chip" data-qty="1">Just 1</span>' +
                        '<span class="tmf-chip" data-qty="skip">Never</span>' +
                    '</div>' +
                    '<label>Round listed price</label>' +
                    '<select class="tmf-modal-round">' +
                        '<option value="0">Exact (no rounding)</option>' +
                        '<option value="10">To $10</option>' +
                        '<option value="100">To $100</option>' +
                        '<option value="1000">To $1,000</option>' +
                    '</select>' +
                    '<label>Round direction</label>' +
                    '<select class="tmf-modal-round-dir">' +
                        '<option value="nearest">Nearest</option>' +
                        '<option value="down">Always down (undercut)</option>' +
                        '<option value="up">Always up (never below)</option>' +
                    '</select>' +
                '</div>' +
                '<div class="tmf-modal-section">' +
                    '<h4>Torn API</h4>' +
                    '<div class="tmf-modal-key">' +
                        '<input type="password" class="tmf-modal-apikey" placeholder="Public API key (16 characters)" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
                        '<span class="tmf-modal-key-reveal" title="Show the key">Show</span>' +
                    '</div>' +
                '</div>' +
                '<div class="tmf-modal-section">' +
                    '<h4>Per-category overrides</h4>' +
                    '<div class="tmf-modal-cat-head"><span>Category</span><span>Price</span><span>Quantity</span><span></span></div>' +
                    '<div class="tmf-modal-cats"></div>' +
                    '<button type="button" class="tmf-modal-addcat">+ Add category</button>' +
                    '<button type="button" class="tmf-modal-resetcat" title="Forget cached item categories. Use if Torn recategorised an item and a wrong discount is being applied.">Reset learned categories</button>' +
                    '<button type="button" class="tmf-modal-clearexcl" title="Un-exclude every item marked ⊘, including ones not currently on screen.">Clear exclusions</button>' +
                '</div>' +
                '<div class="tmf-modal-error"></div>' +
                '<div class="tmf-modal-actions">' +
                    '<button type="button" class="tmf-modal-cancel">Cancel</button>' +
                    '<button type="button" class="tmf-modal-save">Save</button>' +
                '</div>' +
                '<details class="tmf-modal-help"><summary>Formula cheat sheet</summary>' +
                '<p><b>Shape:</b> a discount, then a source in brackets. <code>+5%[avg]</code> = average sale price plus 5%. <code>-1[0]</code> = cheapest listing minus $1. <code>-1</code> or <code>+5%</code> with no bracket start from the cheapest listing.</p>' +
                '<p><b>Item market:</b> <code>[0]</code> cheapest, <code>[1]</code> 2nd cheapest, <code>[median]</code> median listing, <code>[avg]</code> average sale price (the &ldquo;market price&rdquo; on the market page).</p>' +
                '<p><b>Torn market value:</b> <code>[market]</code>, the item&rsquo;s market-value figure from the item list. It can differ from <code>[avg]</code>; the popup shows which number was used.</p>' +
                '<p><b>Bazaars</b> (weav3r.dev, no key): <code>[bazaar]</code>, <code>[bazaar:2]</code>, <code>[bazaar:avg]</code>, <code>[bazaar:median]</code>.</p>' +
                '<p><b>Combine:</b> <code>-1[bazaar] | -1[0]</code> fills the higher of the two. <code>min(...)</code> fills the lower. Nest them for a range: <code>min(max(-1[0], +10%[avg]), -1[14])</code>. If any source fails, the row is left unfilled.</p>' +
                '<p><b>Quantity:</b> <code>max</code>, <code>max-1</code>, a number, or <code>skip</code>. Category rows use the same syntax and need an API key to be recognised. Leave the price blank to restore <code>-1[0]</code>; blank the key to remove it.</p>' +
                '</details>' +
            '</div>' +
            '<datalist id="tmf-modal-cat-list">' + SETTINGS_CATEGORIES.map(c => '<option value="' + c + '"></option>').join('') + '</datalist>';
        document.body.appendChild(overlay);

        overlay.querySelector('.tmf-modal-close').addEventListener('click', closeSettingsModal);
        overlay.querySelector('.tmf-modal-cancel').addEventListener('click', closeSettingsModal);
        overlay.addEventListener('click', function(event){ if (event.target === overlay){ closeSettingsModal(); } });
        overlay.querySelector('.tmf-modal-addcat').addEventListener('click', function(){ addCategoryRow('', '', ''); });
        overlay.querySelector('.tmf-modal-resetcat').addEventListener('click', function(event){
            clearItemCategoryCache();
            let btn = event.target;
            btn.textContent = 'Cleared ✓';
            setTimeout(function(){ btn.textContent = 'Reset learned categories'; }, 1500);
        });
        overlay.querySelector('.tmf-modal-clearexcl').addEventListener('click', function(event){
            excluded.clear();
            saveExcluded();
            document.querySelectorAll('.tmf-fav').forEach(function(el){
                renderFavIcon(el, getItemState(parseInt(el.dataset.tmfItemId, 10)));
            });
            let btn = event.target;
            btn.textContent = 'Cleared ✓';
            setTimeout(function(){ btn.textContent = 'Clear exclusions'; }, 1500);
        });
        // The key is masked like a password so it cannot be read off a shared screen or a
        // screenshot. "Show" is there for the times you do need to check it.
        overlay.querySelector('.tmf-modal-key-reveal').addEventListener('click', function(event){
            const keyInput = overlay.querySelector('.tmf-modal-apikey');
            const hidden = keyInput.type === 'password';
            keyInput.type = hidden ? 'text' : 'password';
            event.target.textContent = hidden ? 'Hide' : 'Show';
            event.target.title = hidden ? 'Hide the key' : 'Show the key';
        });
        overlay.querySelector('.tmf-modal-save').addEventListener('click', saveSettingsModal);

        const deltaField = overlay.querySelector('.tmf-modal-delta');
        const qtyField = overlay.querySelector('.tmf-modal-qty');
        // Live feedback: say right away whether the formula parses, instead of at Save.
        function refreshLive(){
            const live = overlay.querySelector('.tmf-modal-live');
            const problem = settingProblem(deltaField.value);
            live.classList.toggle('tmf-bad', problem != null);
            live.classList.toggle('tmf-ok', problem == null);
            live.textContent = problem != null ? problem : describeSetting(deltaField.value);
            deltaField.classList.toggle('tmf-modal-invalid', problem != null);
        }
        deltaField.addEventListener('input', refreshLive);
        overlay.addEventListener('click', function(event){
            const tab = event.target.closest ? event.target.closest('.tmf-tab') : null;
            if (tab != null){
                switchSettingsProfile(overlay, tab.dataset.profile);
                return;
            }
            const chip = event.target.closest ? event.target.closest('.tmf-chip') : null;
            if (chip == null){
                return;
            }
            if (chip.dataset.formula != null){
                deltaField.value = chip.dataset.formula;
                refreshLive();
            } else if (chip.dataset.qty != null){
                qtyField.value = chip.dataset.qty;
            }
        });
        overlay.refreshLive = refreshLive;
    }

    function addCategoryRow(name, formula, quantity){
        const list = document.querySelector('.tmf-modal-cats');
        if (list == null){
            return;
        }
        const row = document.createElement('div');
        row.className = 'tmf-modal-cat-row';
        row.innerHTML =
            '<input type="text" class="tmf-modal-cat-name" list="tmf-modal-cat-list" placeholder="Category">' +
            '<input type="text" class="tmf-modal-cat-formula" placeholder="-5%">' +
            '<input type="text" class="tmf-modal-cat-qty" placeholder="max-1">' +
            '<span class="tmf-modal-cat-del" title="Remove">&times;</span>';
        row.querySelector('.tmf-modal-cat-name').value = name;
        row.querySelector('.tmf-modal-cat-formula').value = formula;
        row.querySelector('.tmf-modal-cat-qty').value = quantity;
        row.querySelector('.tmf-modal-cat-del').addEventListener('click', function(){ row.remove(); });
        list.appendChild(row);
    }

    // ---- Per-page settings profiles -----------------------------------------------------------
    // "market" and "bazaar" each have a price formula, a default quantity and per-category rules.
    // The current page's profile lives in the runtime variables; the other one is read from storage.
    const PAGE_PROFILE = isBazaarPage ? 'bazaar' : 'market';
    const PROFILE_DEFAULT_DELTA = { market: '-1[0]', bazaar: '-5[bazaar]' };
    const BAZAAR_PRESETS = [
        { label: 'Cheapest bazaar -$5', formula: '-5[bazaar]', hint: 'Cheapest bazaar listing minus $5 (default)' },
        { label: 'Cheapest bazaar -$1', formula: '-1[bazaar]', hint: 'Cheapest bazaar listing minus $1' },
        { label: 'Match median', formula: '[bazaar:median]', hint: 'Median bazaar listing, no discount' },
        { label: '5% above avg price', formula: '+5%[avg]', hint: 'Average sale price from the item market, plus 5%' }
    ];

    function readStoredMap(key){
        try {
            let parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    function loadProfile(name){
        let delta = name === 'market' ? priceDeltaRaw : bazaarDeltaRaw;
        if (name === PAGE_PROFILE){
            return { delta: delta, qty: quantityModeRaw, round: roundingStep, roundDir: roundingDir, catDeltas: name === 'market' ? categoryDeltas : {}, catQty: categoryQuantities };
        }
        if (name === 'market'){
            return { delta: delta, qty: localStorage.getItem(QUANTITY_KEY_MARKET) ?? 'max', round: readRounding(ROUNDING_KEY_MARKET), roundDir: readRoundingDir(ROUNDING_DIR_KEY_MARKET),
                     catDeltas: readStoredMap(categoryDeltasKey), catQty: readStoredMap(CATEGORY_QUANTITIES_KEY_MARKET) };
        }
        return { delta: delta, qty: localStorage.getItem(QUANTITY_KEY_BAZAAR) ?? localStorage.getItem(QUANTITY_KEY_MARKET) ?? 'max',
                 round: readRounding(ROUNDING_KEY_BAZAAR), roundDir: readRoundingDir(ROUNDING_DIR_KEY_BAZAAR), catDeltas: {}, catQty: readStoredMap(CATEGORY_QUANTITIES_KEY_BAZAAR) };
    }

    // The editable shape: one row per category named by either map.
    function profileToDraft(profile){
        let names = [...new Set(Object.keys(profile.catDeltas).concat(Object.keys(profile.catQty)))];
        return {
            delta: profile.delta,
            qty: profile.qty,
            round: profile.round,
            roundDir: profile.roundDir,
            rows: names.map(function(name){ return { name: name, formula: profile.catDeltas[name] ?? '', qty: profile.catQty[name] ?? '' }; })
        };
    }

    function saveProfileDraft(name, draft){
        let delta = draft.delta.trim() === '' ? PROFILE_DEFAULT_DELTA[name] : draft.delta.trim();
        let qty = draft.qty.trim() === '' ? 'max' : draft.qty.trim();
        let round = ROUNDING_STEPS.indexOf(Number(draft.round)) !== -1 ? Number(draft.round) : 0;
        localStorage.setItem(name === 'market' ? ROUNDING_KEY_MARKET : ROUNDING_KEY_BAZAAR, String(round));
        let roundDir = ROUNDING_DIRS.indexOf(draft.roundDir) !== -1 ? draft.roundDir : 'nearest';
        localStorage.setItem(name === 'market' ? ROUNDING_DIR_KEY_MARKET : ROUNDING_DIR_KEY_BAZAAR, roundDir);
        if (name === PAGE_PROFILE){
            roundingStep = round;
            roundingDir = roundDir;
        }
        let catDeltas = {};
        let catQty = {};
        draft.rows.forEach(function(row){
            let key = row.name.trim().toLowerCase();
            if (key === ''){
                return;
            }
            if (row.formula.trim() !== ''){
                catDeltas[key] = row.formula.trim();
            }
            if (row.qty.trim() !== ''){
                catQty[key] = row.qty.trim();
            }
        });
        // Written out explicitly, even when blank, so a default can never resurface from a legacy key.
        if (name === 'market'){
            priceDeltaRaw = delta;
            localStorage.setItem("freaky-market-helper-price-delta", delta);
            localStorage.setItem(QUANTITY_KEY_MARKET, qty);
            localStorage.setItem(categoryDeltasKey, JSON.stringify(catDeltas));
            localStorage.setItem(CATEGORY_QUANTITIES_KEY_MARKET, JSON.stringify(catQty));
        } else {
            bazaarDeltaRaw = delta;
            localStorage.setItem("freaky-market-helper-bazaar-delta", delta);
            localStorage.setItem(QUANTITY_KEY_BAZAAR, qty);
            localStorage.setItem(CATEGORY_QUANTITIES_KEY_BAZAAR, JSON.stringify(catQty));
        }
        if (name === PAGE_PROFILE){
            quantityModeRaw = qty;
            categoryQuantities = catQty;
            if (name === 'market'){
                categoryDeltas = catDeltas;
            }
        }
    }

    function collectSettingsDraft(overlay){
        return {
            delta: overlay.querySelector('.tmf-modal-delta').value,
            qty: overlay.querySelector('.tmf-modal-qty').value,
            round: Number(overlay.querySelector('.tmf-modal-round').value),
            roundDir: overlay.querySelector('.tmf-modal-round-dir').value,
            rows: Array.from(overlay.querySelectorAll('.tmf-modal-cat-row')).map(function(row){
                return {
                    name: row.querySelector('.tmf-modal-cat-name').value,
                    formula: row.querySelector('.tmf-modal-cat-formula').value,
                    qty: row.querySelector('.tmf-modal-cat-qty').value
                };
            })
        };
    }

    // Show one profile's draft in the form: its own presets, placeholder and category columns.
    function renderSettingsProfile(overlay, name){
        overlay.activeProfile = name;
        let draft = overlay.drafts[name];
        let isBazaar = name === 'bazaar';
        overlay.querySelectorAll('.tmf-tab').forEach(function(tab){
            tab.classList.toggle('tmf-tab--on', tab.dataset.profile === name);
        });
        overlay.querySelector('.tmf-modal').classList.toggle('tmf-modal--bazaar', isBazaar);
        overlay.querySelector('.tmf-modal-profile-sub').textContent = isBazaar
            ? 'Bazaar Add Items and click-to-fill. Bazaar sales carry no tax.'
            : 'Item Market Add Items. Item market sales pay a 5% tax.';
        overlay.querySelector('.tmf-price-chips').innerHTML = (isBazaar ? BAZAAR_PRESETS : PRICE_PRESETS).map(function(preset){
            return '<span class="tmf-chip" data-formula="' + escapeHtml(preset.formula) + '" title="' + escapeHtml(preset.hint) + '">' + escapeHtml(preset.label) + '</span>';
        }).join('');
        overlay.querySelector('.tmf-modal-delta').placeholder = PROFILE_DEFAULT_DELTA[name];
        overlay.querySelector('.tmf-modal-delta').value = draft.delta;
        overlay.querySelector('.tmf-modal-qty').value = draft.qty;
        overlay.querySelector('.tmf-modal-round').value = String(draft.round ?? 0);
        overlay.querySelector('.tmf-modal-round-dir').value = draft.roundDir ?? 'nearest';
        const list = overlay.querySelector('.tmf-modal-cats');
        list.innerHTML = '';
        draft.rows.forEach(function(row){ addCategoryRow(row.name, row.formula, row.qty); });
        clearSettingsError(overlay);
        if (overlay.refreshLive) { overlay.refreshLive(); }
    }

    function switchSettingsProfile(overlay, name){
        if (name == null || name === overlay.activeProfile){
            return;
        }
        overlay.drafts[overlay.activeProfile] = collectSettingsDraft(overlay);
        renderSettingsProfile(overlay, name);
    }

    function openSettingsModal(){
        ensureSettingsModal();
        const overlay = document.querySelector('.tmf-settings-overlay');
        overlay.drafts = { market: profileToDraft(loadProfile('market')), bazaar: profileToDraft(loadProfile('bazaar')) };
        renderSettingsProfile(overlay, PAGE_PROFILE);
        const keyInput = overlay.querySelector('.tmf-modal-apikey');
        keyInput.value = (apiKey != null && apiKey.indexOf('PDA-APIKEY') === -1) ? apiKey : '';
        // Remembered so Save can tell "the user emptied the field" (remove the key) from "there
        // was never anything to show" (e.g. a PDA-supplied key, which must be left alone).
        keyInput.dataset.initialKey = keyInput.value;
        // However the key was left last time, it is masked again on every open.
        keyInput.type = 'password';
        const keyReveal = overlay.querySelector('.tmf-modal-key-reveal');
        keyReveal.textContent = 'Show';
        keyReveal.title = 'Show the key';
        overlay.classList.add('tmf-modal-overlay--open');
    }

    function closeSettingsModal(){
        const overlay = document.querySelector('.tmf-settings-overlay');
        if (overlay != null){
            overlay.classList.remove('tmf-modal-overlay--open');
        }
    }

    // ---- Settings validation ----------------------------------------------------------
    // Save refuses anything the filler could not act on later. A bad formula used to be stored
    // happily and then fail every row that reached it, with nothing on screen to say why.

    // A price formula is an optional discount ("-1", "+5", "-5%") followed by an optional
    // source in brackets. Either half may be left out; a bare source means "as it stands".
    function formulaProblem(branch){
        let open = branch.indexOf('[');
        let delta = (open === -1 ? branch : branch.substring(0, open)).trim();
        if (delta !== '' && !/^[-+]?\d+(\.\d+)?%?$/.test(delta)){
            return "'" + delta + "' is not a discount. Use -1, +5, -5%, or nothing at all.";
        }
        if (open === -1){
            return null;
        }
        let close = branch.indexOf(']', open);
        if (close === -1){
            return "'" + branch + "' is missing its closing ].";
        }
        if (branch.substring(close + 1).trim() !== ''){
            return "'" + branch + "' has stray text after the ].";
        }
        let token = bracketToken(branch);
        if (token === 'market' || token === 'avg' || token === 'average' || token === 'median' || /^\d+$/.test(token)){
            return null;
        }
        if (token === 'bazaar' || token.indexOf('bazaar:') === 0){
            let argument = token.substring('bazaar'.length).replace(/^:/, '').trim();
            if (argument === '' || argument === 'avg' || argument === 'average' || argument === 'median' || /^\d+$/.test(argument)){
                return null;
            }
            return "[" + token + "] is not a bazaar source. Use [bazaar], [bazaar:2], [bazaar:avg] or [bazaar:median].";
        }
        return "[" + token + "] is not a price source. Use [0], [median], [avg], [market] or [bazaar].";
    }

    // Whole setting: a lone formula, "a | b", or min(...)/max(...) around a list of them, which
    // may themselves hold further calls. Blank is always fine, since it means "use the default".
    function settingProblem(setting){
        let raw = String(setting ?? '').trim();
        if (raw === ''){
            return null;
        }
        // Checked once up front so the term walk below can trust every ( to have its ).
        let depth = 0;
        for (let i = 0; i < raw.length; i++){
            if (raw.charAt(i) === '('){
                depth++;
            } else if (raw.charAt(i) === ')'){
                depth--;
                if (depth < 0){
                    return "there is a ) with no ( to open it.";
                }
            }
        }
        if (depth > 0){
            return "min() and max() need a closing ).";
        }
        return expressionProblem(raw);
    }

    // One level of a setting: the terms between its separators, each a call or a formula.
    function expressionProblem(body){
        let terms = splitTopLevel(body);
        for (let i = 0; i < terms.length; i++){
            let term = terms[i].trim();
            if (term === ''){
                return "there is an empty formula next to a separator.";
            }
            let open = term.indexOf('(');
            if (open === -1){
                let problem = formulaProblem(term);
                if (problem != null){
                    return problem;
                }
                continue;
            }
            let name = term.substring(0, open).trim().toLowerCase();
            if (name !== 'min' && name !== 'max'){
                return name === ''
                    ? "a formula cannot start with (. Only min(...) and max(...) use brackets."
                    : "'" + term.substring(0, open).trim() + "' is not a function. Only min(...) and max(...) use brackets.";
            }
            let close = matchingParen(term, open);
            if (term.substring(close + 1).trim() !== ''){
                return "'" + term + "' has stray text after the ). Separate formulas with | or ,.";
            }
            let inner = term.substring(open + 1, close);
            if (inner.trim() === ''){
                return "min() and max() need at least one formula between the brackets.";
            }
            let problem = expressionProblem(inner);
            if (problem != null){
                return problem;
            }
        }
        return null;
    }

    function reportSettingsError(overlay, input, message){
        let box = overlay.querySelector('.tmf-modal-error');
        if (box != null){
            box.textContent = message;
            box.style.display = 'block';
        }
        input.classList.add('tmf-modal-invalid');
        input.focus();
        return false;
    }

    function clearSettingsError(overlay){
        if (overlay == null){
            return;
        }
        let box = overlay.querySelector('.tmf-modal-error');
        if (box != null){
            box.textContent = '';
            box.style.display = 'none';
        }
        overlay.querySelectorAll('.tmf-modal-invalid').forEach(function(input){
            input.classList.remove('tmf-modal-invalid');
        });
    }

    // The first problem in one profile's draft, as {message, field} — field says which input to mark.
    function draftProblem(draft, label){
        let deltaProblem = settingProblem(draft.delta);
        if (deltaProblem != null){
            return { message: label + ' price: ' + deltaProblem, field: { kind: 'delta' } };
        }
        if (draft.qty.trim() !== '' && !isKnownQuantityMode(draft.qty)){
            return { message: label + ' quantity: use max, max-1, a plain number, or skip.', field: { kind: 'qty' } };
        }
        for (let i = 0; i < draft.rows.length; i++){
            let row = draft.rows[i];
            let name = row.name.trim();
            if (name === ''){
                // An entirely blank row is dropped on save; only one carrying settings is a
                // mistake worth stopping for.
                if (row.formula.trim() !== '' || row.qty.trim() !== ''){
                    return { message: label + ': this category row needs a category name.', field: { kind: 'row', index: i, part: 'name' } };
                }
                continue;
            }
            let rowProblem = settingProblem(row.formula);
            if (rowProblem != null){
                return { message: label + ' ' + name + ' price: ' + rowProblem, field: { kind: 'row', index: i, part: 'formula' } };
            }
            if (row.qty.trim() !== '' && !isKnownQuantityMode(row.qty)){
                return { message: label + ' ' + name + ' quantity: use max, max-1, a plain number, or skip.', field: { kind: 'row', index: i, part: 'qty' } };
            }
        }
        return null;
    }

    // True when every field of both profiles can be saved. Otherwise the tab with the first bad
    // field is shown, the field is marked, the reason is given, and nothing the user typed is lost.
    function validateSettingsModal(overlay){
        clearSettingsError(overlay);
        overlay.drafts[overlay.activeProfile] = collectSettingsDraft(overlay);
        let order = [overlay.activeProfile, overlay.activeProfile === 'market' ? 'bazaar' : 'market'];
        for (let i = 0; i < order.length; i++){
            let name = order[i];
            let problem = draftProblem(overlay.drafts[name], name === 'market' ? 'Item Market' : 'Bazaar');
            if (problem == null){
                continue;
            }
            if (overlay.activeProfile !== name){
                renderSettingsProfile(overlay, name);
            }
            let input;
            if (problem.field.kind === 'delta'){
                input = overlay.querySelector('.tmf-modal-delta');
            } else if (problem.field.kind === 'qty'){
                input = overlay.querySelector('.tmf-modal-qty');
            } else {
                input = overlay.querySelectorAll('.tmf-modal-cat-row')[problem.field.index].querySelector('.tmf-modal-cat-' + problem.field.part);
            }
            return reportSettingsError(overlay, input, problem.message);
        }
        let keyInput = overlay.querySelector('.tmf-modal-apikey');
        let key = keyInput.value.trim();
        if (key !== '' && key.length !== 16){
            return reportSettingsError(overlay, keyInput, 'Public API key: a Torn key is 16 characters long.');
        }
        return true;
    }

    function saveSettingsModal(){
        const overlay = document.querySelector('.tmf-settings-overlay');
        if (overlay == null){
            return;
        }
        if (!validateSettingsModal(overlay)){
            return;
        }
        saveProfileDraft('market', overlay.drafts.market);
        saveProfileDraft('bazaar', overlay.drafts.bazaar);
        const keyInput = overlay.querySelector('.tmf-modal-apikey');
        let keyVal = keyInput.value.trim();
        if (keyVal.length === 16){
            apiKey = keyVal;
            localStorage.setItem("freaky-market-helper-apikey", keyVal);
        } else if (keyVal === '' && (keyInput.dataset.initialKey ?? '') !== ''){
            // The user emptied a key that was showing: remove it. A field that was empty from
            // the start (no key, or a PDA-supplied one) is left alone.
            apiKey = null;
            localStorage.removeItem("freaky-market-helper-apikey");
        }
        closeSettingsModal();
        refreshQuickChanges();
    }

    function performOperation(number, operation) {
        // A formula that is nothing but a source — "[market]", "[bazaar]" — leaves no delta
        // behind, and means "take the source price as it stands".
        if (operation == null || operation.trim() === '') {
            return number;
        }
        const match = operation.match(/^([-+]?)(\d+(?:\.\d+)?)(%)?$/);
        if (!match) {
            throw new Error('Invalid operation string');
        }
        const [, operator, operand, isPercentage] = match;
        const operandValue = parseFloat(operand);
        const adjustedOperand = isPercentage ? (number * operandValue) / 100 : operandValue;
        switch (operator) {
            case '':
            case '+':
                return number + adjustedOperand;
            case '-':
                return number - adjustedOperand;
            default:
                throw new Error('Invalid operator');
        }
    }

    function formatNumberWithCommas(number) {
        return new Intl.NumberFormat('en-US').format(number);
    }

    function checkApiKey(checkExisting = true) {
        if (!needsTornApiKey()){
            return;
        }
        if (!checkExisting || !hasUsableApiKey()){
            // Never pre-filled: a browser prompt shows its contents in plain text, and this
            // dialog is the one that ends up on screen when the script is being demonstrated.
            let userInput = prompt("Please enter a PUBLIC Api Key, it will be used to get current bazaar prices:", '');
            if (userInput !== null && userInput.trim().length == 16) {
                apiKey = userInput.trim();
                localStorage.setItem("freaky-market-helper-apikey", apiKey);
            } else {
                console.error("[FreakyMarketHelper] User cancelled the Api Key input.");
            }
        }
    }

    // The median unit across every listing, weighted by quantity. Walks the sorted listings
    // instead of expanding them unit by unit, which a stack of millions would never survive.
    function getMedianPrice(items) {
        const sorted = items
            .map(item => ({ price: item.price, amount: Math.max(0, Math.floor(item.amount ?? 1)) }))
            .filter(item => item.amount > 0)
            .sort((a, b) => a.price - b.price);
        const total = sorted.reduce((sum, item) => sum + item.amount, 0);
        if (total === 0) {
            return items.length > 0 ? items[0].price : undefined;
        }
        // The price of the unit at 0-based position `index` in the sorted run.
        const unitAt = index => {
            for (const item of sorted) {
                if (index < item.amount) {
                    return item.price;
                }
                index -= item.amount;
            }
        };
        const mid = Math.floor(total / 2);
        return total % 2 === 0 ? (unitAt(mid - 1) + unitAt(mid)) / 2 : unitAt(mid);
    }

    function getCurrentPage(){
        // Case-insensitive, and tolerant of the "Your Items" naming Torn uses for the
        // view-listings tab.
        let href = window.location.href.toLowerCase();
        if (isBazaarPage){
            // The bazaar's Add Items and Manage tabs.
            if (/#\/add(\/|\?|$)/.test(href)){
                return pages.AddItems;
            }
            return /#\/manage(\/|\?|$)/.test(href) ? pages.ViewItems : pages.Other;
        }
        if (href.indexOf('#/addlisting') > -1){
            return pages.AddItems;
        } else if (href.indexOf('#/viewlisting') > -1 || href.indexOf('#/youritems') > -1){
            return pages.ViewItems;
        } else {
            return pages.Other;
        }
    }

    function getCurrentMarketTax() {
        return 0.05;
    }

    const startHold = () => {
        clearTimeout(holdTimer);
        holdFired = false;
        holdTimer = setTimeout(() => {
            // The release that ends this hold will fire a click; flag it so it is swallowed.
            holdFired = true;
            openSettingsModal();
        }, 2000);
    };

    const cancelHold = () => {
        clearTimeout(holdTimer);
    };

    class StringBuilder {
        constructor() {
            this.parts = [];
        }
        append(str) {
            this.parts.push(str);
            return this;
        }
        toString() {
            return this.parts.join('');
        }
    }
})();
