/* Seed 100 distinct HR questions into the database.
 * Generation logic: 20 topics x 5 templates = 100 unique combinations.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const topics = [
  'отпуск',
  'больничный',
  'командировку',
  'удалённую работу',
  'изменение графика',
  'смену должности',
  'повышение грейда',
  'оплату переработок',
  'перевод в другой офис',
  'возмещение расходов',
  'корпоративное обучение',
  'оформление пропуска',
  'смену банковского счета',
  'получение справки 2-НДФЛ',
  'доступ к корпоративным системам',
  'онбординг новичка',
  'выход из декретного отпуска',
  'смену фамилии',
  'смену руководителя',
  'закрытие рабочего дня',
];

const templates = [
  (topic) => `Как оформить ${topic}?`,
  (topic) => `Куда подать запрос на ${topic}?`,
  (topic) => `Сроки обработки запроса на ${topic}?`,
  (topic) => `Что делать, если отказали в ${topic}?`,
  (topic) => `Какие документы нужны для ${topic}?`,
];

function buildAnswer(topic) {
  return `Заполни заявку в HRIS/боте, выбери пункт "${topic}", приложи подтверждающие документы и жди согласования руководителя и HR.`;
}

async function main() {
  const existing = await prisma.question.findMany({ select: { question: true } });
  const existingSet = new Set(existing.map((q) => q.question));

  const data = [];
  let idx = 0;
  for (const topic of topics) {
    for (const tpl of templates) {
      const question = tpl(topic);
      if (existingSet.has(question)) continue;
      data.push({ question, answer: buildAnswer(topic) });
      idx++;
    }
  }

  if (data.length === 0) {
    console.log('Нет новых вопросов для вставки (все 100 уже существуют).');
    return;
  }

  const chunkSize = 50;
  let inserted = 0;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    const res = await prisma.question.createMany({ data: chunk });
    inserted += res.count;
  }

  console.log(`Готово. Добавлено вопросов: ${inserted} (из 100 уникальных шаблонов).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
