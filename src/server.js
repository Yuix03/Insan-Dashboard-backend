/**
 * server.js — entry point
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import amoRoutes from './routes.js';

const app = express();

// Настройка CORS для свободного доступа с вашего React-дашборда
app.use(cors());
app.use(express.json());

// Проверка наличия переменных окружения при старте
console.log('--- System Check ---');
console.log('AMO_DOMAIN =', process.env.AMO_DOMAIN ? 'Установлен' : 'ОТСУТСТВУЕТ');
console.log('AMO_TOKEN =', process.env.AMO_TOKEN ? 'Установлен' : 'ОТСУТСТВУЕТ');
console.log('--------------------');

// На Render убрана жесткая остановка сервера (process.exit), 
// чтобы сервис не падал в цикле, если переменные еще не добавлены в настройки.
if (!process.env.AMO_DOMAIN || !process.env.AMO_TOKEN) {
  console.warn('⚠️ ВНИМАНИЕ: AMO_DOMAIN или AMO_TOKEN не заданы в переменных окружения (Environment) на Render!');
  console.warn('API amoCRM вернет ошибку при запросе, пока вы не добавите ключи.');
}

// Подключение роутера amoCRM
app.use('/api', amoRoutes);

// Базовый роут для проверки работоспособности (Render использует его для проверки статуса)
app.get('/', (req, res) => {
  res.send('Backend is running successfully on Render!');
});

// Глобальный обработчик ошибок (предотвращает падение сервера при ошибках в роутах)
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// Render автоматически передает нужный порт через process.env.PORT
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Backend успешно запущен на порту: ${PORT}`);
  console.log(`📡 Локальный адрес: http://localhost:${PORT}/api`);
  console.log(`🌍 Публичный адрес на Render: следите за URL в панели управления`);
});
