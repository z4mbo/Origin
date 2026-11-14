import { expect, test } from "vitest";
import { estimateLabel, isEstimate, totalEstimate } from "./estimates";
import { readIssueView } from "./issue-view";

test("estimates are points on the Fibonacci scale and add up per lane", () => {
  expect([1, 2, 3, 5, 8].every(isEstimate)).toBe(true);
  expect([0, 4, 13, "3", null].some(isEstimate)).toBe(false);
  expect(estimateLabel(1)).toBe("1 point");
  expect(estimateLabel(5)).toBe("5 points");
  expect(totalEstimate([{ estimate: 3 }, {}, { estimate: 5 }, { estimate: 4 }])).toBe(8);
});

test("estimates are gone from views: stored views drop the property and the ordering", () => {
  expect(readIssueView({ version: 2, properties: ["id", "estimate", "labels"], ordering: "estimate" })).toMatchObject({ properties: ["id", "labels"], ordering: "manual" });
  expect(readIssueView({ properties: ["id", "labels"] }).properties).toEqual(["id", "labels"]);
});
