import * as esbuild from 'esbuild';

await esbuild.build({
    entryPoints: ['src/index.js'],
    bundle: true,
    outfile: 'dist/ansi-editor.js',
    format: 'iife',
    globalName: 'AnsiEditorModule',
    loader: { '.css': 'text' },
    footer: { js: 'if(typeof window!=="undefined")window.AnsiEditor=AnsiEditorModule.AnsiEditor;' },
    sourcemap: true,
    target: ['es2020'],
});

console.log('Build complete: dist/ansi-editor.js');
