import fs from 'fs';
import path from 'path';

export function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data));
}

export function getFilePath(user_id, folder = 'ScanCodeLoginData') {
    return path.join('data', 'WzryData', folder, `${user_id}.json`);
} 