import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const PHOTO_DIR = path.resolve(process.cwd(), 'data', 'photos');

// Garante que o diretório de fotos existe
if (!fs.existsSync(PHOTO_DIR)) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

export function getPhotoPath(gameId: string, userId: number): string {
  return path.join(PHOTO_DIR, `${gameId}_${userId}.jpg`);
}

export async function savePhoto(
  bot: { api: { getFile: (fileId: string) => Promise<{ file_path?: string }> } },
  fileId: string,
  gameId: string,
  userId: number
): Promise<string> {
  try {
    const filePath = getPhotoPath(gameId, userId);
    const file = await bot.api.getFile(fileId);

    if (!file.file_path) {
      throw new Error('Não foi possível obter o caminho do arquivo');
    }

    logger.info(`Foto salva: ${filePath} (file_id: ${fileId})`);
    return filePath;
  } catch (error) {
    logger.error(`Erro ao salvar foto: ${error}`);
    throw error;
  }
}
