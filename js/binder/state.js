// Shared mutable state for the binder view modules (js/binder/).
// Mirrors 1:1 the variables that sat at the top of the old js/binder-view.js
// IIFE, plus the mid-file lets that cross module seams (demoSeq,
// aestheticsMode, cardBrowserInited, cbDebounceTimer, and the listings-cache
// block) — same names, same initial values, same comments. Modules read/write
// these as properties (state.allListings, state.currentPage, …) exactly where
// the old code used the bare variables. Do not restructure.

// Signed-out interactive demo (embedded in a carousel on my-binders.html):
// ?demo=optcg|pokemon runs the REAL binder view on an in-memory binder — no
// saves (every DB write is DEMO-gated). demoCat/DEMO were consts derived from
// the URL at the top of the IIFE; they are re-derived here so every module
// can read them from state.
const demoCat = (new URLSearchParams(location.search).get('demo') || '').toLowerCase();

export const state = {
  demoCat,
  DEMO: ['optcg', 'pokemon', 'cyberpunk'].includes(demoCat),

  ownerUserId: null,
  viewerUserId: null,
  isOwner: false,
  isCollab: false,           // viewer is a shared-binder collaborator (co-editor)
  canEdit: false,            // isOwner || isCollab — may edit the binder + its cards
  currentBinderId: null,     // the binder we're viewing
  binderCategory: 'optcg',   // 'optcg' | 'pokemon' — drives filter UI + card-browser query
  binderFlair: null,         // binder flair ('wishlist' enables deck-origin surfacing)

  demoSeq: 0,
  aestheticsMode: false,
  cardBrowserInited: false,
  cbDebounceTimer: null,

  allListings: [],           // full binder cache (used for client-side filtering)
  decksById: {},             // deck_id → {id,name,leader_card_code} for wishlist deck-origin pills
  currentListings: [],       // currently rendered (full or filtered)
  currentPage: 1,
  pendingFocusCode: null,    // card_code to scroll the binder to after the next render (e.g. just-added card)
  pendingKeepPage: null,     // page number to stay on across the next render (e.g. after "Got it")
  binderLayout: '4x3',       // set from DB on load
  lastShowEditControls: false,
  lastIsLoggedIn: false,
  sleeveImageUrl: null,      // owner's custom sleeve background, applied to every tile
};
