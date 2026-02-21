/**
 * server.js — entry point
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import amoRoutes from './routes.js';

const app = express();

// Настройка CORS для доступа с вашего фронтенда (обычно localhost:3000 или 5173)
app.use(cors());
app.use(express.json());

// Проверка наличия переменных окружения при старте
console.log('--- System Check ---');
console.log('AMO_DOMAIN =', process.env.AMO_DOMAIN);
console.log('AMO_TOKEN exists =', !!process.env.AMO_TOKEN);
console.log('--------------------');

if (!process.env.AMO_DOMAIN || !process.env.AMO_TOKEN) {
  console.error('❌ ОШИБКА: AMO_DOMAIN или AMO_TOKEN не заданы в .env файле');
  process.exit(1);
}

// Подключение роутера amoCRM
app.use('/api', amoRoutes);

// Базовый роут для проверки работоспособности
app.get('/', (req, res) => {
  res.send('Backend is running');
});

// Глобальный обработчик ошибок (предотвращает падение сервера при ошибках в роутах)
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Backend запущен на http://localhost:${PORT}`);
  console.log(`📡 API доступно по адресу http://localhost:${PORT}/api`);
});