# backend/scripts

Two kinds of thing live here, and they should not be confused.

## Tools that belong to the product

- **normalizeBranches.js** — collapses branch spellings to a canonical list.
- **normalizePlaces.js** — merges location rows that are one office written
  several ways, from a hand-written list of merges.

Both are per-organisation by nature and both currently hold VisionFund's data
inline: `normalizeBranches.js` has ninety lines of Kenyan branch names, and
`normalizePlaces.js` names specific row ids. **Neither works for a second
organisation as written.**

They should become a screen: show an admin the distinct spellings in their own
register, let them group them, store the mapping against the organisation. The
logic is right; only the hardcoded data is wrong. Until then, treat them as
VisionFund-only and read the comments — `normalizePlaces.js` records four
merges it deliberately refuses to make, including one that would have folded
an office marked "Not In Use" over the one in use.

## One-off repairs, kept only as history

Everything in `archive/visionfund/` was written to fix one organisation's data
once: chassis numbers, motor vehicle records, a particular spreadsheet import.
They are not part of the product and should not be run.

They are kept because several of them document what was wrong with the source
data, which is context you will want when the same shape of problem appears in
a new tenant's spreadsheet.
