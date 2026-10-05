import { haircuts, styling, hairTreatments, colour } from "./hair.mjs"
import { facials, waxing, detan, threading } from "./skin.mjs"
import { nails, bodyTreatments, reflexology, makeup, bridal, mehendi, kids, mens } from "./body.mjs"

export const MENU = [
  ...haircuts, ...styling, ...hairTreatments, ...colour,
  ...facials, ...waxing, ...detan, ...threading,
  ...nails, ...bodyTreatments, ...reflexology, ...makeup, ...bridal, ...mehendi, ...kids, ...mens,
]

export const AUDIENCES = ["WOMEN", "MEN", "UNISEX", "BOY", "GIRL"]

/** Returns a list of problems; an empty list means the dataset is internally consistent. */
export function validateMenu(menu = MENU) {
  const problems = []
  const names = new Set()
  for (const s of menu) {
    const key = s.name.trim().toLowerCase()
    if (names.has(key)) problems.push(`duplicate name: ${s.name}`)
    names.add(key)
    if (!AUDIENCES.includes(s.audience)) problems.push(`${s.name}: bad audience ${s.audience}`)
    if (!s.category) problems.push(`${s.name}: no category`)
    if ((s.description ?? "").length < 500) problems.push(`${s.name}: description ${(s.description ?? "").length} chars (<500)`)
    const rows = s.variants ?? [s.price]
    if (!rows.length || rows.some(r => !r)) problems.push(`${s.name}: no price`)
    if (s.variants) {
      const labels = new Set()
      for (const [label, reg, mem] of s.variants) {
        if (labels.has(label.toLowerCase())) problems.push(`${s.name}: duplicate variant ${label}`)
        labels.add(label.toLowerCase())
        if (!(reg > 0)) problems.push(`${s.name}/${label}: bad price`)
        if (mem !== null && !(mem > 0)) problems.push(`${s.name}/${label}: bad member price`)
        if (mem !== null && mem > reg) problems.push(`${s.name}/${label}: member > regular`)
      }
    } else {
      const [reg, mem] = s.price
      if (!(reg > 0)) problems.push(`${s.name}: bad price`)
      if (mem !== null && (!(mem > 0) || mem > reg)) problems.push(`${s.name}: bad member price`)
    }
  }
  return problems
}
