import { describe, expect, it } from "vitest";

import { AUTOMATIC_SERIAL_GAP_LIMIT, nextAutomaticSerial } from "./order-serial-allocation.js";

const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, index) => String(from + index));

describe("nextAutomaticSerial (smart last number)", () => {
  it("uses a gap limit of 10", () => {
    expect(AUTOMATIC_SERIAL_GAP_LIMIT).toBe(10);
  });

  it.each([
    ["no serials that day", [], "1"],
    ["1-63", range(1, 63), "64"],
    ["1-63 and a typed 500", [...range(1, 63), "500"], "64"],
    ["1-60, 62, 63 (small natural gap is not refilled)", [...range(1, 60), "62", "63"], "64"],
    ["500 only", ["500"], "1"],
    ["1-10 and 25", [...range(1, 10), "25"], "11"],
    ["1-63 and 70 (gap 7 is within the limit)", [...range(1, 63), "70"], "71"],
    ["1-63, 75 and 500", [...range(1, 63), "75", "500"], "64"],
    ["1-74, 75 and 500", [...range(1, 75), "500"], "76"],
    ["1-499 and 500", range(1, 500), "501"],
  ])("%s -> next serial", (_label, existing, expected) => {
    expect(nextAutomaticSerial(existing)).toBe(expected);
  });

  it("is independent of input order and duplicates", () => {
    const shuffled = [...range(1, 63), "500", "12", "63", "1"].reverse();
    expect(nextAutomaticSerial(shuffled)).toBe("64");
  });

  it("ignores non-numeric serials", () => {
    expect(nextAutomaticSerial([...range(1, 5), "A-77", "SER-000900", " "])).toBe("6");
  });

  it("steps over a number that is already taken", () => {
    // 64 typed by someone: it is within the limit, so it becomes the real last.
    expect(nextAutomaticSerial([...range(1, 63), "64"])).toBe("65");
    // A number the caller just lost a race for is passed in as taken.
    expect(nextAutomaticSerial([...range(1, 63), "64", "65"])).toBe("66");
  });

  it("treats zero-padded serials by their numeric value", () => {
    expect(nextAutomaticSerial(["001", "002", "003"])).toBe("4");
  });

  it("handles numbers beyond the safe integer range", () => {
    expect(nextAutomaticSerial(["9007199254740993"])).toBe("1");
    expect(nextAutomaticSerial(["9007199254740992", "9007199254740993"])).toBe(
      "9007199254740994",
    );
  });
});
