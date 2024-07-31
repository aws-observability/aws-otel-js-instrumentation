module.exports = {
  plugins: [
    "@typescript-eslint",
    "header",
    "node",
    "prettier"
  ],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "plugin:prettier/recommended"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    "project": "./tsconfig.json"
  },
  rules: {
    "quotes": ["error", "single", { "avoidEscape": true }],
    "eqeqeq": [
      "error",
      "smart"
    ],
    "prefer-rest-params": "off",
    "no-shadow": "off",
    "node/no-deprecated-api": ["warn"],
    "header/header": ["error", "line", [
      "Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.",
      "SPDX-License-Identifier: Apache-2.0"
    ]]
  },
  overrides: [
    {
      files: ['*.ts'],
      rules: {
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/no-this-alias": "off",
        "@typescript-eslint/naming-convention": [
          "error",
          {
            "selector": "memberLike",
            "modifiers": ["private", "protected"],
            "format": ["camelCase"],
            "leadingUnderscore": "require"
          }
        ],
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/no-inferrable-types": 0,
        "@typescript-eslint/typedef": ["warn", {
          "variableDeclaration": true
        }],
        "@typescript-eslint/no-empty-function": ["off"],
        "@typescript-eslint/ban-types": ["warn", {
          "types": {
            "Function": null,
          }
        }],
        "@typescript-eslint/no-shadow": ["warn"],
      }
    },
    {
      files: ["test/**/*.ts"],
      rules: {
        "no-empty": "off",
        "@typescript-eslint/ban-ts-ignore": "off",
        "@typescript-eslint/no-empty-function": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/no-shadow": ["off"],
        "@typescript-eslint/no-floating-promises": ["off"],
        "@typescript-eslint/no-non-null-assertion": ["off"],
        "@typescript-eslint/explicit-module-boundary-types": ["off"]
      }
    }
  ]
};