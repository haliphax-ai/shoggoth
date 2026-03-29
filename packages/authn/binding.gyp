{
  'targets': [
    {
      'target_name': 'shoggoth_peercred',
      'conditions': [
        ['OS=="linux"', {
          'sources': ['src/native/peercred_linux.cc']
        }, {
          'sources': ['src/native/peercred_stub.cc']
        }]
      ]
    }
  ]
}
