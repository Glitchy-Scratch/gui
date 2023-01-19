module.exports = {
    extends: ['scratch/react', 'scratch/es6', 'plugin:jest/recommended'],
    env: {
        browser: true,
        jest: true
    },
    plugins: ['jest'],
    rules: {
        'react/prop-types': 0,
        'jest/expect-expect': 0,
        'jest/no-disabled-tests': 0,
        'jest/no-conditional-expect': 0,
        'jest/valid-title': 0,
        'jest/no-done-callback': 0,
        'jest/no-mocks-import': 0,
    }
};
