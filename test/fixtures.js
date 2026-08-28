'use strict';

function makeEmbeddedData() {
  return {
    gastos: {
      porCategoria: [{ k: 'MARKETING', n: 1, v: 500 }],
      mesCategoria: [{ ym: '2025-12', cat: 'MARKETING', v: 500 }],
      porMes: [
        { ym: '2025-12', n: 2, v: 500 },
        // Esta linha representa o retrato antigo incorporado e nunca pode
        // concorrer com o CSV diário a partir de 2026.
        { ym: '2026-04', n: 99, v: 900000 }
      ],
      gasto2026MesUnid: [
        { ym: '2026-04', unid: 'Ribeirão Preto', v: 900000 }
      ]
    },
    gastoDetalhado: {
      u: ['Ribeirão Preto', 'Itaim Bibi'],
      t: ['Operacional'],
      r: [
        ['2512', 0, 0, 500, 2],
        ['2604', 0, 0, 900000, 99]
      ]
    },
    atendimentos: {
      u: ['Ribeirão Preto', 'Itaim Bibi'],
      p: ['Profissional A'],
      r: [
        ['2604', 0, -1, 10, 10000, 0, 0],
        ['2604', 0, 0, 4, 2, 1, 1],
        ['2604', 1, -1, 5, 5000, 0, 0],
        ['2604', 1, 0, 2, 1, 0, 1],
        ['2605', 0, -1, 12, 12000, 0, 0],
        ['2605', 0, 0, 6, 3, 2, 1]
      ]
    },
    dre: {
      rows: [{
        competencia: '2026-04', unidade: 'Ribeirão Preto', receitaBruta: 10000,
        impostos: 500, devolucoes: 0, receitaLiquida: 9500, custosDespesas: 6000,
        ebitda: 3500, irpjCsll: 300, lucroLiquido: 3200
      }]
    }
  };
}

function makeCurrentCsv() {
  return [
    'DATA2;DATA;VALOR;CATEGORIA;UNIDADE;TIPO DE GASTO',
    'texto que nao e data;01/04/2026;"1.234,56";"Marketing; Performance";RP;Operacional',
    'ignorado;02/04/2026;200,00;Material;SP;Operacional',
    'ignorado;31/12/2025;777,00;Antigo;RP;Operacional',
    'ignorado;28/08/2026;888,00;Futuro;RP;Operacional'
  ].join('\n');
}

module.exports = { makeCurrentCsv, makeEmbeddedData };
