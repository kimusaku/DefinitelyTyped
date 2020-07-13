import generator from '@babel/generator';
import * as parser from '@babel/parser';
import * as t from '@babel/types';
import deasync from 'deasync';
import { command } from 'execa';
import * as fs from 'fs';
import { sync as mkdirp } from 'mkdirp';
import { ncp as _ncp } from 'ncp';
import { cpus } from 'os';
import * as path from 'path';
import { sync as rimraf } from 'rimraf';

const ncp = deasync(_ncp);

const workDirBase = path.resolve(`${process.cwd()}/work`);
if (fs.existsSync(workDirBase)) {
    rimraf(workDirBase);
}
mkdirp(workDirBase);

const resultDir = path.resolve(`${process.cwd()}/result`);
if (fs.existsSync(resultDir)) {
    rimraf(resultDir);
}
mkdirp(resultDir);

function assumeModuleName(typing: string): string {
    const matches = /^(.+)__(.*)$/i.exec(typing);
    if (matches === null) {
        return typing;
    }
    matches.shift();
    return `@${matches.join('/')}`;
}

const ignores = ['node_modules', 'build'];

function forEachFile(current: string, where: (src: string) => boolean, apply: (src: string) => void): void {
    const names = fs.readdirSync(current, 'utf8');
    for (const name of names) {
        if (ignores.includes(name)) {
            continue;
        }
        const src = path.join(current, name);
        const stat = fs.lstatSync(src);
        if (stat.isDirectory()) {
            forEachFile(src, where, apply);
        } else if (stat.isFile() && where(src)) {
            apply(src);
        }
    }
}

async function main(name: string, n: number): Promise<boolean> {
    const moduleName = assumeModuleName(name);
    const typesDir = path.resolve(`${process.cwd()}/types/${name}`);
    const workDir = `${workDirBase}/${name}`;
    try {
        mkdirp(workDir);
        ncp(typesDir, workDir);

        forEachFile(
            workDir,
            src => ['.ts', '.tsx'].includes(path.extname(src)) && !src.endsWith('.d.ts'),
            src => {
                const file = fs.readFileSync(src, 'utf8');
                const ast = parser.parse(file, {
                    allowReturnOutsideFunction: true,
                    plugins: ['jsx', 'typescript'],
                    sourceType: 'module',
                });

                const { body } = ast.program;
                const isImportDeclaration = (stmt: t.Statement) =>
                    t.isImportDeclaration(stmt) || t.isTSImportEqualsDeclaration(stmt);
                const imports = body.filter(isImportDeclaration);
                const rest = body.filter(stmt => !isImportDeclaration(stmt));
                ast.program = t.program([
                    ...imports,
                    t.functionDeclaration(t.identifier('func'), [], t.blockStatement(rest)),
                ]);

                fs.writeFileSync(src, generator(ast).code, 'utf8');
                fs.writeFileSync(
                    `${resultDir}/${n}-${name}-${path.relative(workDir, src).replace(/\//g, '_')}`,
                    generator(ast).code,
                    'utf8',
                );
            },
        );

        forEachFile(
            workDir,
            src => src.endsWith('.d.ts'),
            src => {
                fs.copyFileSync(src, `${resultDir}/${n}-${name}-${path.relative(workDir, src).replace(/\//g, '_')}`);
            },
        );

        const packageJsonPath = `${workDir}/package.json`;
        if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            packageJson.name = `${packageJson.name}-test`;
            if (packageJson.dependencies === undefined) {
                packageJson.dependencies = {};
            }
            packageJson.dependencies[moduleName] = 'latest';
            fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
        } else {
            fs.writeFileSync(
                `${workDir}/package.json`,
                `{
    "name": "${moduleName}-test",
    "version": "1.0.0",
    "dependencies": {
    "${moduleName}": "latest"
    }
    }`,
                'utf8',
            );
        }

        fs.writeFileSync(
            `${workDir}/.escapinrc.js`,
            `module.exports = {
name: '${name}',
platform: 'aws',
output_dir: 'build',
};`,
            'utf8',
        );

        fs.writeFileSync(
            `${workDir}/.gitignore`,
            `node_modules/
.escapinrc.js
build/`,
            'utf8',
        );

        const subprocess = command(`nohup ts-node -P ../escapin/tsconfig.json ../escapin/src/cli.ts -d ${workDir} &`, {
            env: {
                NODE_ENV: 'test',
            },
        });
        subprocess.stdout?.pipe(fs.createWriteStream(`${resultDir}/${n}-stdout.log`));
        subprocess.stderr?.pipe(fs.createWriteStream(`${resultDir}/${n}-stderr.log`));

        await subprocess;

        forEachFile(
            `${workDir}/build`,
            src => ['.ts', '.tsx'].includes(path.extname(src)) && !src.endsWith('.d.ts'),
            src => {
                fs.copyFileSync(
                    src,
                    `${resultDir}/${n}-${name}-${path
                        .relative(`${workDir}/build`, src.replace('.ts', '-result.ts'))
                        .replace(/\//g, '_')}`,
                );
            },
        );

        console.log(`${n},"${moduleName}","ok"`);
        return true;
    } catch (err) {
        const msg = err.toString();
        if (msg.indexOf('npm ERR! code E404') !== -1) {
            console.log(`${n},"${moduleName}","module not found"`);
        } else if (msg.indexOf('ERR! code EBADPLATFORM') !== -1) {
            console.log(`${n},"${moduleName}","bad platform"`);
        } else if (msg.indexOf('SyntaxError') !== -1) {
            console.log(`${n},"${moduleName}","syntax error"`);
        } else if (msg.indexOf('TypeError') !== -1) {
            console.log(`${n},"${moduleName}","type error"`);
        } else if (msg.indexOf('npm ERR!') !== -1) {
            console.log(`${n},"${moduleName}","npm error"`);
        } else {
            console.log(`${n},"${moduleName}","error"`);
        }
        console.error(err);
        return false;
    } finally {
        rimraf(workDir);
    }
}

// import parse from 'csv-parse/lib/sync';
// function assumeDirectoryName(moduleName: string): string {
//     const matches = /^@(.+)\/(.*)$/i.exec(moduleName);
//     if (matches === null) {
//         return moduleName;
//     }
//     matches.shift();
//     return `${matches.join('__')}`;
// }
//
// (async () => {
//     const csv = parse(fs.readFileSync('stdout2.csv', 'utf8'), {
//         columns: true,
//         skip_empty_lines: true
//     }) as Array<{ no: number, name: string, status: string }>;
//     for (const record of csv) {
//         if (record.status === 'error') {
//             const succeeded = await main(assumeDirectoryName(record.name), record.no);
//             if (!succeeded) {
//                 process.exit(0);
//             }
//         }
//     }
// })();

const N = cpus().length;
const finished: Array<Promise<boolean>> = [];

(async () => {
    let n = 0;
    const names = fs.readdirSync(`${process.cwd()}/types`, 'utf8');
    let workers: Array<Promise<boolean>> = [];
    console.log(`"no","name","status"`);
    while (true) {
        if (names.length === 0 && workers.length === 0) {
            break;
        }
        if (names.length > 0 && workers.length < N) {
            ++n;
            const worker = main(names.shift(), n);
            worker.then(succeeded => {
                finished.push(worker);
                return Promise.resolve(succeeded);
            });
            workers.push(worker);
            continue;
        }
        await Promise.race(workers);
        workers = workers.filter(worker => !finished.includes(worker));
    }
})();
