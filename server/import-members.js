/* ============================================================
   One-time member import for Ramatlabama FM.
   Safe & idempotent: adds any member below whose email is not
   already present in the live users.json. Run it from the Render
   Shell once; running it again changes nothing.

   Usage (from the project's server folder on Render):
     node import-members.js

   It writes to the SAME file the server uses:
     $DATA_DIR/users.json   (defaults to this folder if DATA_DIR unset)
   ============================================================ */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA_DIR, "users.json");

// Members to ensure exist. The two defaults (god/ceo) are managed by the
// server itself and are intentionally NOT included here.
const MEMBERS = [
  { id: "umvzkiseu", login: "", email: "padiahglantorious@ramatlabamafm.co.za", name: "Padiah Glantorious", title: "Operations Manager & DevOps", role: "presenter", password: "@Traprusty07" },
  { id: "umvzlus0v", login: "", email: "melbamangwani@ramatlabamafm.co.za", name: "Melba Mangwani", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvznbd20", login: "", email: "omphilemogorosi@ramatlabamafm.co.za", name: "Omphile Mogorosi", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvzncuqf", login: "", email: "reabetsweselebalo@ramatlabamafm.co.za", name: "Reabetswe selebalo", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvznejbd", login: "", email: "morutidavidmoruti@ramatlabamafm.co.za", name: "Moruti David Moruti", title: "Presenter & programs Manager", role: "elevated", password: "presenter2026" },
  { id: "umvznfycr", login: "", email: "lesegomabote@ramatlabamafm.co.za", name: "Lesego Mabote", title: "Presenter & ass operations manager", role: "presenter", password: "presenter2026" },
  { id: "umvzngszc", login: "", email: "jennamaboe@ramatlabamafm.co.za", name: "Jenna Maboe", title: "Presenter & Ass Programs manager", role: "presenter", password: "presenter2026" },
  { id: "umvznhlg6", login: "", email: "emmanuelboefelo@ramatlabamafm.co.za", name: "Emmanuel Boefelo", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvzniba2", login: "", email: "twaronamops@ramatlabamafm.co.za", name: "T warona Mops", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvznit0l", login: "", email: "olebilemotaung@ramatlabamafm.co.za", name: "Olebile Motaung", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvznjbvg", login: "", email: "tsietsimelato@ramatlabamafm.co.za", name: "Tsietsi melato", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvzogtd4", login: "", email: "celestbergoor@ramatlabamafm.co.za", name: "Celest", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvzohui4", login: "", email: "botsheloitumeleng@ramatlabamafm.co.za", name: "Botshelo", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvzp3l3z", login: "", email: "juniornkuna@ramatlabamafm.co.za", name: "Junior Nkuna", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umvzp74lo", login: "", email: "xolaniboyce@ramatlabamafm.co.za", name: "Xolani", title: "Presenter", role: "presenter", password: "presenter2026" },
  { id: "umw07wwn6", login: "", email: "dineomaeco@ramatlabamafm.co.za", name: "Dineo Maeco", title: "Human Resources", role: "presenter", password: "presenter2026" },
];

function load() {
  if (!fs.existsSync(USERS_FILE)) {
    console.log("No existing users.json — starting a new one.");
    return { users: [] };
  }
  let raw = fs.readFileSync(USERS_FILE, "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM if present
  try {
    return JSON.parse(raw);
  } catch (e) {
    // The file exists but is unreadable. Do NOT overwrite it — bail out so we
    // never wipe real accounts because of a transient parse problem.
    console.error("ERROR: users.json exists but could not be parsed. Aborting to avoid data loss.");
    console.error(e.message);
    process.exit(1);
  }
}

const db = load();
if (!Array.isArray(db.users)) {
  console.error("ERROR: users.json has no 'users' array. Aborting.");
  process.exit(1);
}

const existingEmails = new Set(
  db.users.filter((u) => u.email).map((u) => u.email.toLowerCase())
);
const existingIds = new Set(db.users.map((u) => u.id));

let added = 0, skipped = 0;
for (const m of MEMBERS) {
  const emailKey = m.email.toLowerCase();
  if (existingEmails.has(emailKey) || existingIds.has(m.id)) {
    skipped++;
    console.log("  skip (already present):", m.email);
    continue;
  }
  db.users.push(m);
  existingEmails.add(emailKey);
  existingIds.add(m.id);
  added++;
  console.log("  added:", m.email);
}

fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
console.log(`\nDone. Added ${added}, skipped ${skipped}. Total users now: ${db.users.length}`);
console.log("File:", USERS_FILE);
