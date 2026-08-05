/**
 * src/rail/receipt — the land-receipt surface (glance#334, rail T6). Internal barrel; the PUBLIC seam
 * for consumers OUTSIDE src/rail is src/rail/index.ts, which re-exports this. See render-html.ts for
 * the product surface, write.ts for the write/post side, types.ts for the boundary object.
 */

export type { LandReceipt, LandReceiptGate, LandReceiptCost, GateStatus, PanelVerdict } from "./types.ts";
export { renderReceiptHtml } from "./render-html.ts";
export { renderReceiptComment, type CommentOptions } from "./render-comment.ts";
export { classifyLand, writeLandReceipt, postReceiptComment, landReceiptDir, landReceiptFilename } from "./write.ts";
