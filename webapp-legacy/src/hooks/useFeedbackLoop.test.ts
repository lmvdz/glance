import { expect, test } from "bun:test";
import type { FeedbackReward, FeedbackSummary } from "../lib/dto";
import { feedbackActionState, filterFeedbackItems } from "./useFeedbackLoop";

const base: FeedbackSummary = {
  id: "fb_1",
  campaignId: "fc_1",
  repo: "/repo",
  kind: "feature",
  title: "Add bulk triage",
  status: "new",
  rewardStatus: "pending",
  validationCount: 0,
  votes: { valid: 0, invalid: 0, unsure: 0 },
  hasAttachment: false,
  createdAt: 1,
  updatedAt: 1,
};

const reward: FeedbackReward = {
  id: "fr_1",
  feedbackId: "fb_1",
  campaignId: "fc_1",
  repo: "/repo",
  amount: 2500,
  currency: "USD",
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
};

test("filters feedback summaries by lane", () => {
  expect(filterFeedbackItems([base, { ...base, id: "fb_2", status: "accepted" }], "accepted").map((item) => item.id)).toEqual(["fb_2"]);
});

test("derives safe feedback actions from item and reward state", () => {
  expect(feedbackActionState(base, reward)).toMatchObject({
    canAccept: true,
    canReject: true,
    canPromote: false,
    canValidate: true,
    canApproveReward: true,
    canVoidReward: true,
    canMarkRewardPaid: false,
  });

  expect(feedbackActionState({ ...base, status: "accepted", planeIssue: undefined }, { ...reward, status: "approved" })).toMatchObject({
    canPromote: true,
    canApproveReward: false,
    canMarkRewardPaid: true,
  });

  expect(feedbackActionState({ ...base, status: "promoted" }, { ...reward, status: "paid" })).toMatchObject({
    canAccept: false,
    canReject: false,
    canPromote: false,
    canValidate: false,
    canVoidReward: false,
  });
});
