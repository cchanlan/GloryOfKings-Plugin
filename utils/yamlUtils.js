import fs from 'fs';
import YAML from 'yaml';

export function readYamlFile(filePath) {
    return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeYamlFile(filePath, data) {
    fs.writeFileSync(filePath, YAML.stringify(data), 'utf8');
} 