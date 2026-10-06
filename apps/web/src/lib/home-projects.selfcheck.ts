import { ok as expect } from "node:assert/strict";

import { homeFolderList, homeOpenFolderCard } from "./home-projects";

const list = homeFolderList({ path: "/abs/path/nano", name: "nano" }, [
  { path: "/abs/path/nano", name: "nano" },
  { path: "/abs/path/arm", name: "arm" },
  { path: "  ", name: "blank" },
  { path: "/abs/path/empty-name", name: "  " },
]);

expect(
  list.map((row) => row.path).join(",") ===
    "/abs/path/nano,/abs/path/arm,/abs/path/empty-name",
  "current first, duplicates and blanks dropped"
);
expect(list[2]?.name === "empty-name", "blank name uses the path segment");
expect(
  homeFolderList(null, [{ path: "/abs/path/only" }]).length === 1,
  "recents without a current folder"
);
expect(homeFolderList(null, []).length === 0, "empty home");
expect(homeOpenFolderCard(true), "host can open a folder");
expect(homeOpenFolderCard(false) === false, "guest has no open card");

console.log("home-projects.selfcheck ok");
