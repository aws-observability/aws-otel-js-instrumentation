const path = require('path');

const commonConfig = {
  target: 'node',
  mode: 'production',
  externalsPresets: { node: true },
  output: {
    path: path.resolve('./build/src'),
    library: {
        type: 'commonjs2',
    }
  },
  resolve: {
    extensions: ['.ts', '.js'],
    modules: [
        path.resolve('./src'),
        'node_modules',
    ],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.webpack.json'
            },
          }
        ],
        exclude: /node_modules/,
      },
    ],
  },
};

const wrapperConfig = {
  ...commonConfig,
  entry: './src/wrapper.ts',
  output: {
    ...commonConfig.output,
    filename: 'wrapper.js',
  },
  externals: [
    'import-in-the-middle',
    'require-in-the-middle',
    /^@aws-sdk/,
    /^@smithy/,
  ],
  optimization: {
    minimize: true,
    providedExports: true,
    usedExports: true,
  },
};

const liteWrapperConfig = {
  ...commonConfig,
  entry: './src/lite-wrapper.ts',
  output: {
    ...commonConfig.output,
    filename: 'lite-wrapper.js',
  },
  externals: [
    'import-in-the-middle',
    'require-in-the-middle',
    /^@aws-sdk/,
    /^@smithy/,
  ],
  optimization: {
    minimize: false,
  },
};

module.exports = [wrapperConfig, liteWrapperConfig];
