// Answers store for an annotate.js-enabled page. Rename to "<htmlbasename>-threads.js".
// The bridge writes this file; without the bridge, the reader copies their questions from the
// Comments panel ("⋯" → Copy questions, full instructions included) and Claude appends
// {role:"user"} + {role:"claude"} messages here, keyed by the thread id. Answers may use
// markdown (bold, lists, tables, `code`, code fences, math); it renders in the comment cards.
// Reload the page to see answers appear beside the highlighted text, box or block.
//
//   window.ANNOTATE_THREADS = {
//     "<id>": {
//       label: "<short human label, copied verbatim from the batch>",
//       anchor: { type:"text",    exact, prefix, suffix }   // highlighted words (re-located by phrase + surroundings)
//             |  { type:"region",  x, y, w, h, ... }        // drawn box; fractions 0..1 of the content box (+ optional pinning / scroll)
//             |  { type:"element", sel, tag, text },        // picked block or diagram node (selector, then tag + text)
//       messages: [ {role:"user",text:"…"}, {role:"claude",text:"…"} ]  // append; never replace
//     }
//   };
window.ANNOTATE_THREADS = {
};
