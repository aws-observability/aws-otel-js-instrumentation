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
      "off",
      "smart"
    ],
    "prefer-rest-params": "off",
    "no-shadow": "off",
    "node/no-deprecated-api": ["warn"],
    "header/header": [2, "block", [
        "",
        " * Copyright Amazon.com, Inc. or its affiliates.",
        " *",
        " * Licensed under the Apache License, Version 2.0 (the \"License\").",
        " * You may not use this file except in compliance with the License.",
        " * A copy of the License is located at",
        " *",
        " *  http://aws.amazon.com/apache2.0",
        " *",
        " * or in the \"license\" file accompanying this file. This file is distributed",
        " * on an \"AS IS\" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either",
        " * express or implied. See the License for the specific language governing",
        " * permissions and limitations under the License.",
        " "
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
        "@typescript-eslint/typedef": [
            "warn",
            {
                "variableDeclaration": true
            }
        ],
        "@typescript-eslint/no-empty-function": ["off"],
        "@typescript-eslint/no-unused-vars": [
            "warn",
            {
                "argsIgnorePattern": "^_",
                "varsIgnorePattern": "^_",
                "caughtErrorsIgnorePattern": "^_"
            }
        ],
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
    },
    {
      files: ["src/version.ts"],
      rules: {
        "@typescript-eslint/typedef": "off",
        "header/header": "off"
      }
    },
  ]
};