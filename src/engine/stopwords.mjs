export const STOPWORDS = new Set((
  'el la los las un una unos unas de del al a en y o u e que se su sus por para con sin sobre entre ' +
  'es son fue ser era eran esta este esto estos estas ese esa eso esos esas muy mas pero como cuando ' +
  'donde porque tambien ya no si lo le les me te nos mi tu yo el ella ellos ellas nosotros hay ha han ' +
  'he hemos tiene tienen tengo esta estan estoy estamos todo todos toda todas cada otro otra otros ' +
  'the a an and or but of to in on at for with by from is are was were be been it its this that these ' +
  'those i you he she we they my your his her our their not so if as do does did have has had will ' +
  'would can could just very more most than then there here what which who whom'
).split(/\s+/));

export function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]/g, '');
}
