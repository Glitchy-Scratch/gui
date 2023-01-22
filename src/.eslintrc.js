/* eslint-disable import/no-commonjs */

// eslint-disable-next-line import/no-nodejs-modules
const path = require('path');
module.exports = {
    root: true,
    extends: ['scratch', 'scratch/es6', 'scratch/react', 'plugin:import/errors'],
    env: {
        browser: true
    },
    globals: {
        process: true
    },
    rules: {
        'import/no-mutable-exports': 'error',
        'import/no-commonjs': 'off',
        'import/no-amd': 'error',
        'import/no-nodejs-modules': 'error',
        'react/jsx-no-literals': 'error',
        'no-prototype-builtins': 'off',
        'no-confusing-arrow': ['error', {
            allowParens: true
        }]
    },
    settings: {
        'react': {
            version: '16.2' // Prevent 16.3 lifecycle method errors
        },
        'import/resolver': {
            webpack: {
                // eslint-disable-next-line no-undef
                config: path.resolve(__dirname, '../webpack.config.js')
            }
        }
    }
};
