
export default {
  version: 2,
  name: "combo-health",
  up(db) {
    const columns = db.all("PRAGMA table_info(combos)").map((column) => column.name);
    if (!columns.includes("errorThreshold")) db.exec("ALTER TABLE combos ADD COLUMN errorThreshold INTEGER NOT NULL DEFAULT 4");
  },
};
