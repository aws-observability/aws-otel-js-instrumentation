const path = require('path');

module.exports = {
  entry: './src/register.ts',
  target: 'node',
  mode: 'production',
  externalsPresets: { node: true },
  externals: [
    'import-in-the-middle',
  ],
  output: {
    path: path.resolve('./build/src'),
    filename: 'register.js',
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
  optimization: {
    minimize: true,
    providedExports: true,
    usedExports: true,
  },
};
