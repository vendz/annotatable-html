// Answers store for an annotate.js-enabled page. Rename to "<htmlbasename>-threads.js".
// Claude owns this file. The user adds questions in the page, copies the exported batch
// (the "📋 Copy questions for Claude" button embeds full instructions), and Claude appends
// {role:"user"} + {role:"claude"} messages here, keyed by the thread id. Answers may use
// markdown (bold, lists, `code`, code fences) — it renders in the sidebar.
// Reload the page to see answers land on the highlighted text / region / element (pins turn green).
//
//   window.ANNOTATE_THREADS = {
//     "<id>": {
//       label: "<short human label — copy verbatim from the batch>",
//       anchor: { type:"text",    exact, prefix }      // text highlight (re-located by exact phrase)
//             |  { type:"region",  x, y, w, h }         // drawn box; fractions 0..1 of the content box
//             |  { type:"element", sel, tag, text },    // clicked element (re-located by selector, then tag+text)
//       messages: [ {role:"user",text:"…"}, {role:"claude",text:"…"} ]  // append; never replace
//     }
//   };
window.ANNOTATE_THREADS = {
};
