/**
 * src/rail/receipt — the land-receipt surface (glance#334, rail T6). Internal barrel; the PUBLIC seam
 * for consumers OUTSIDE src/rail is src/rail/index.ts, which re-exports this. See render-html.ts for
 * the product surface, write.ts for the write/post side, types.ts for the boundary object.
 */

export type { LandReceipt, LandReceiptGate, LandReceiptCost, GateStatus, PanelVerdict, LandReceiptIndexRow, LandReceiptPrecision } from "./types.ts";
export { renderReceiptHtml } from "./render-html.ts";
export { renderReceiptComment, mdEsc, type CommentOptions } from "./render-comment.ts";
export { classifyLand, writeLandReceipt, postReceiptComment, landReceiptDir, landReceiptFilename, landReceiptIndexRow, landReceiptIndexPath, LAND_RECEIPT_INDEX_FILE } from "./write.ts";
