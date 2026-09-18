import { describe, it, expect } from "vitest";

describe("Hermes Prompt Sanitization", () => {
  const replaceStr = (str) => {
    let res = str;
    res = res.replaceAll("You are Hermes Agent, built by Nous Research", "You are smart AI Agent");
    res = res.replaceAll("Hermes Agent is an open-source AI agent framework by Nous Research", "AI Agent is an open-source AI agent framework");
    res = res.replaceAll("https://hermes-agent.nousresearch.com/docs", "");
    res = res.replace(/(?<![/\\])Hermes(?![/\\.\-_?#&=a-zA-Z0-9])/g, (match, offset, fullText) => {
      const left = fullText.slice(0, offset);
      const right = fullText.slice(offset + match.length);
      const prevSpace = Math.max(left.lastIndexOf(" "), left.lastIndexOf("\n"), left.lastIndexOf("\t"), left.lastIndexOf('"'), left.lastIndexOf("'"));
      const nextSpace = (() => {
        const idxs = [right.indexOf(" "), right.indexOf("\n"), right.indexOf("\t"), right.indexOf('"'), right.indexOf("'")].filter(i => i !== -1);
        return idxs.length > 0 ? Math.min(...idxs) : -1;
      })();
      const tokenBefore = prevSpace === -1 ? left : left.slice(prevSpace + 1);
      const tokenAfter = nextSpace === -1 ? right : right.slice(0, nextSpace);
      const fullToken = tokenBefore + match + tokenAfter;

      if (/[/\\]/.test(fullToken) || /^[a-zA-Z]:/.test(fullToken) || /^https?:\/\//i.test(fullToken) || /\.[a-zA-Z0-9]+$/.test(fullToken)) {
        return match;
      }
      return "AI Agent";
    });
    return res;
  };

  it("does not replace Hermes in any arbitrary file path or URL", () => {
    // Windows path variants (Hermes at end, middle, beginning)
    expect(replaceStr("C:/users/os/data/Hermes")).toBe("C:/users/os/data/Hermes");
    expect(replaceStr("C:\\users\\os\\data\\Hermes")).toBe("C:\\users\\os\\data\\Hermes");
    expect(replaceStr("D:/Workplace/Hermes/src/index.js")).toBe("D:/Workplace/Hermes/src/index.js");
    expect(replaceStr("D:\\Workplace\\Hermes\\src\\index.js")).toBe("D:\\Workplace\\Hermes\\src\\index.js");
    expect(replaceStr("C:/Users/Hermes")).toBe("C:/Users/Hermes");

    // Unix path variants
    expect(replaceStr("/var/log/Hermes")).toBe("/var/log/Hermes");
    expect(replaceStr("/home/user/data/Hermes/config.json")).toBe("/home/user/data/Hermes/config.json");
    expect(replaceStr("./Hermes/app.js")).toBe("./Hermes/app.js");
    expect(replaceStr("../Hermes")).toBe("../Hermes");

    // File extensions & URLs
    expect(replaceStr("Hermes.json")).toBe("Hermes.json");
    expect(replaceStr("https://api.domain.com/v1/Hermes")).toBe("https://api.domain.com/v1/Hermes");

    // Standalone words (SHOULD replace)
    expect(replaceStr("Hello Hermes, can you assist?")).toBe("Hello AI Agent, can you assist?");
    expect(replaceStr("Hermes is ready.")).toBe("AI Agent is ready.");
    expect(replaceStr("You are Hermes Agent, built by Nous Research")).toBe("You are smart AI Agent");
  });
});
