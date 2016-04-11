/// <reference path='../typings/node.d.ts' />
/// <reference path='../typings/colors.d.ts' />

import * as ts from 'typescript'
import * as fs from 'fs'
import * as path from 'path'
import * as child_process from 'child_process'
import {repl, defaultPrompt, buffer} from './repl'

const DUMMY_FILE = 'TSUN.repl.generated.ts'
var versionCounter = 0
export var codes = getInitialCommands()

var serviceHost: ts.LanguageServiceHost = {
  getCompilationSettings: () => ({
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES5,
    newLine: ts.NewLineKind.LineFeed,
    noEmitHelpers: true,
    experimentalDecorators: true
  }),
  getScriptFileNames: () => [DUMMY_FILE],
  getScriptVersion: (fileName) => {
    return fileName === DUMMY_FILE && versionCounter.toString()
  },
  getScriptSnapshot: (fileName) => {
    try {
      var text = fileName === DUMMY_FILE
        ? codes
        : fs.readFileSync(fileName).toString()
      return ts.ScriptSnapshot.fromString(text)
    } catch(e) {

    }
  },
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: (options) => path.join(__dirname, '../../node_modules/typescript/lib/lib.core.es6.d.ts')
}

var service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry())

var getDeclarations = (function() {
  var declarations: {[fileName: string]: {[name: string]: ts.DeclarationName[]}} = {}
  let declFiles = getDeclarationFiles().concat(path.join(__dirname, '../../node_modules/typescript/lib/lib.core.es6.d.ts'))
  for (let file of declFiles) {
    let text = fs.readFileSync(file, 'utf8')
    declarations[file] = collectDeclaration(ts.createSourceFile(file, text, ts.ScriptTarget.Latest))
  }
  return function(cached: boolean = false) {
    if (!cached) {
      declarations[DUMMY_FILE] = collectDeclaration(ts.createSourceFile(DUMMY_FILE, codes, ts.ScriptTarget.Latest))
    }
    return declarations
  }
})()

function getDeclarationFiles() {
  var libPaths = [path.resolve(__dirname, '../../typings/node.d.ts')]
  try {
    let typings = path.join(process.cwd(), './typings')
    let dirs = fs.readdirSync(typings)
    for (let dir of dirs) {
      if (!/\.d\.ts$/.test(dir)) continue
      let p = path.join(typings, dir)
      if (fs.statSync(p).isFile()) {
        libPaths.push(p)
      }
    }
  } catch(e) {
  }
  return libPaths
}

function getInitialCommands() {
  var codes = getDeclarationFiles().map(dir => `/// <reference path="${dir}" />`)
  return codes.join('\n')
}

// private api hacks
function collectDeclaration(sourceFile: any): any {
  let decls = sourceFile.getNamedDeclarations()
  var ret: any = {}
  for (let decl in decls) {
    ret[decl] = decls[decl].map((t: any) => t.name)
  }
  return ret
}

function getMemberInfo(member: ts.ClassElement, file: string, parentDeclaration: any): string {
  // member info is stored as the first
  let pos = member.getStart()
  let quickInfo = service.getQuickInfoAtPosition(file, pos)
  if (quickInfo) return ts.displayPartsToString(quickInfo.displayParts)
  // DeclarationName includes Identifier which does not have name and will not go here
  let name = member.name && member.name.getText()
  if (!name) return member.getText()
  let declarations = getDeclarations(true)[file][name]
  for (let decl of declarations) {
    let d: any = decl
    if (parentDeclaration.parent.name.getText() == d.parent.parent.name.getText()) {
      let quickInfo = service.getQuickInfoAtPosition(file, d.getEnd())
      return ts.displayPartsToString(quickInfo.displayParts)
    }
  }
  return member.getText()
}

function getTypeInfo(decl: ts.Node, file: string, detailed: boolean): string[] {
  // getStart will count comment
  let pos = decl.getEnd()
  let ret = [`declaration in: ${file}`]
  let quickInfo = service.getQuickInfoAtPosition(file, pos)
  ret.push(ts.displayPartsToString(quickInfo.displayParts))
  if (!detailed) return ret
  let parentName = ret[1].split(' ')[1]
  let symbolType = quickInfo.displayParts[0].text
  if ( symbolType === 'interface' || symbolType === 'class') {
    let classLikeDeclaration = <ts.ClassLikeDeclaration>decl.parent
    for (let member of classLikeDeclaration.members) {
      let memberInfo = getMemberInfo(member, file, decl).split('\n').map(mInfo => {
        mInfo = mInfo.replace(new RegExp(parentName + '\\.', 'g'), '')
        return '    ' + mInfo
      })
      ret.push(memberInfo.join('\n'))
    }
  }
  return ret

}

export function getSource(name: string) {
  let declarations = getDeclarations()
  for (let file in declarations) {
    let names = declarations[file]
    if (names[name]) {
      let decl = names[name]
      let pager = process.env.PAGER
      let text = decl[0].parent.getFullText()
      if (!pager || text.split('\n').length < 24) {
        console.log(text)
        repl(defaultPrompt)
        return
       }
       process.stdin.pause()
       var tty = require('tty')
       tty.setRawMode(false)
       var temp = require('temp')
       let tempFile = temp.openSync('DUMMY_FILE' + Math.random())
       fs.writeFileSync(tempFile.path, text)
       let display = child_process.spawn('less', [tempFile.path], {
         'stdio': [0, 1, 2]
       })
       display.on('exit', function() {
         temp.cleanupSync()
         tty.setRawMode(true)
         process.stdin.resume()
         repl(defaultPrompt)
       })
       return
    }
  }
  console.log(`identifier ${name} not found`.yellow)
}

export function completer(line: string) {
  // append new line to get completions, then revert new line
  versionCounter++
  let originalCodes = codes
  codes += buffer + '\n' + line
  if (':' === line[0]) {
    let candidates = ['type', 'detail', 'source', 'paste', 'clear', 'print', 'help']
    candidates = candidates.map(c => ':' + c).filter(c => c.indexOf(line) >= 0)
    return [candidates, line.trim()]
  }
  let completions = service.getCompletionsAtPosition(DUMMY_FILE, codes.length)
  if (!completions) {
    codes = originalCodes
    return [[], line]
  }
  let prefix = /[A-Za-z_$]+$/.exec(line)
  let candidates: string[] = []
  if (prefix) {
    let prefixStr = prefix[0]
    candidates = completions.entries.filter((entry) => {
      let name = entry.name
      return name.substr(0, prefixStr.length) == prefixStr
    }).map(entry => entry.name)
  } else {
    candidates = completions.entries.map(entry => entry.name)
  }
  codes = originalCodes
  return [candidates, prefix ? prefix[0] : line]
}

export function getType(name: string, detailed: boolean) {
  let declarations = getDeclarations()
  for (let file in declarations) {
    let names = declarations[file]
    if (names[name]) {
      let decl = names[name][0]
      let infoString = getTypeInfo(decl, file, detailed)
      console.log(infoString.join('\n').cyan)
      return
    }
  }
  console.log(`identifier ${name} not found`.yellow)
}

export function getDiagnostics(code: string): string[] {
  let allDiagnostics = service.getCompilerOptionsDiagnostics()
    .concat(service.getSemanticDiagnostics(DUMMY_FILE))

  let fallback = codes
  codes += code
  versionCounter++
  let ret = allDiagnostics.map(diagnostic => {
    let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    return message
  })
  if (ret.length) codes = fallback
  return ret
}

var storedLine = 0
export function getCurrentCode() {
  let emit = service.getEmitOutput(DUMMY_FILE)
  let lines = emit.outputFiles[0].text.split('\r\n').filter(k => !!k)
  let ret = lines.slice(storedLine).join('\n')
  storedLine = lines.length
  return ret
}

export function getSyntacticDiagnostics(code: string) {
  let fallback = codes
  versionCounter++
  codes += code
  let diagnostics = service.getSyntacticDiagnostics(DUMMY_FILE)
  codes = fallback
  return diagnostics
}

export function clearHistory() {
  codes = getInitialCommands()
}