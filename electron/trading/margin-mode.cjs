function marginMode(value) {
  const mode = value ?? 'isolated';
  if (!['isolated', 'cross'].includes(mode)) throw new Error('Неизвестный режим маржи');
  return mode;
}
module.exports = { marginMode };
