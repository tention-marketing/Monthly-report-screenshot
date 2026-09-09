import { describe, expect, it } from "vitest";
import { selectTopItems, TOP_CAMPAIGN_COUNT, TOP_FLOW_COUNT } from "./index.js";

const items = Array.from({ length: 10 }, (_, index) => ({ id: `item-${index}`, score: index }));
const select = (input: readonly typeof items[number][], limit: number) => selectTopItems({
  items: input, limit, score: (item) => item.score, stableId: (item) => item.id,
});

describe("selectTopItems", () => {
  it("uses the report count constants", () => {
    expect(select(items, TOP_FLOW_COUNT)).toHaveLength(5);
    expect(select(items, TOP_CAMPAIGN_COUNT)).toHaveLength(3);
  });
  it("returns the actual count when fewer items exist", () => expect(select(items.slice(0, 3), 5)).toHaveLength(3));
  it("sorts by descending score", () => expect(select(items, 3).map(({ score }) => score)).toEqual([9, 8, 7]));
  it("uses stable IDs to break ties", () => {
    const tied = [{ id: "z", score: 1 }, { id: "a", score: 1 }];
    expect(select(tied, 2).map(({ id }) => id)).toEqual(["a", "z"]);
  });
  it("does not mutate the input", () => {
    const original = [...items];
    select(items, 3);
    expect(items).toEqual(original);
  });
  it.each([0, -1, 1.5])("rejects invalid limit %s", (limit) => expect(() => select(items, limit)).toThrow());
  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid score %s", (score) => {
    expect(() => select([{ id: "bad", score }], 1)).toThrow();
  });
});
