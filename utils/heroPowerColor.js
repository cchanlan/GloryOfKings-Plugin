export function parseHeroPower (value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** 英雄战力数字专用；缺值不染色，账号战斗力和单局增减不走这套分档。 */
export function heroPowerColor (value) {
  const power = parseHeroPower(value)
  if (power == null) return ''
  if (power <= 2000) return '#ffffff'
  if (power < 5000) return '#79b6ff'
  if (power < 8000) return '#c8a0ff'
  if (power < 10000) return '#f5d76e'
  return '#ff6f7d'
}
