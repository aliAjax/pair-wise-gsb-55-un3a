import { createInitialState } from '../src/data/mock'
import { exportSettingsText } from '../src/services/storage'

const text = exportSettingsText(createInitialState())
console.log(text.split('\n').slice(0, 12).join('\n'))
