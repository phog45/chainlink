import * as h from './support/helpers'
import { assertBigNum } from './support/matchers'
const Coordinator = artifacts.require('dev/Coordinator.sol')
const EmptyAggregator = artifacts.require('test/EmptyAggregator.sol')
const MeanAggregator = artifacts.require('test/MeanAggregator.sol')
const GetterSetter = artifacts.require('GetterSetter.sol')
const MaliciousConsumer = artifacts.require('MaliciousConsumer.sol')
const MaliciousRequester = artifacts.require('MaliciousRequester.sol')

contract('Coordinator', () => {
  let coordinator, link, newServiceAgreement, emptyAggregator, meanAggregator

  beforeEach(async () => {
    link = await h.linkContract()
    coordinator = await Coordinator.new(link.address)
    emptyAggregator = await EmptyAggregator.new()
    meanAggregator = await MeanAggregator.new()
    const fs = name => h.functionSelectorFromAbi(emptyAggregator, name)
    const partialServiceAgreement = {
      aggInitiateJobSelector: fs('initiateJob'), // Currently, meanAggregator and emptyAggregator have the same signatures
      aggFulfillSelector: fs('fulfill'),
    }
    newServiceAgreement = async (aggregator, sA) =>
      h.newServiceAgreement({
        ...partialServiceAgreement,
        ...sA,
        aggregator: aggregator.address,
      })
  })

  it('has a limited public interface', () => {
    h.checkPublicABI(Coordinator, [
      'EXPIRY_TIME',
      'balanceOf',
      'cancelOracleRequest',
      'depositFunds',
      'fulfillOracleRequest',
      'getId',
      'initiateServiceAgreement',
      'onTokenTransfer',
      'oracleRequest',
      'serviceAgreements',
      'withdraw',
      'withdrawableTokens',
    ])
  })

  describe('#getId', async () => {
    it('matches the ID generated by the oracle off-chain', async () => {
      const sA = await newServiceAgreement(emptyAggregator, {
        payment: 1,
        expiration: 2,
        requestDigest:
          '0x85820c5ec619a1f517ee6cfeff545ec0ca1a90206e1a38c47f016d4137e801dd',
      })
      const sAAsData = h.encodedServiceAgreement(sA)
      const result = await coordinator.getId.call(sAAsData)
      assert.equal(result.toLowerCase(), sA.id)
    })
  })

  describe('#initiateServiceAgreement', () => {
    let agreement
    beforeEach(async () => {
      agreement = await newServiceAgreement(emptyAggregator, {
        oracles: [h.oracleNode],
      })
    })

    context('with valid oracle signatures', () => {
      it('saves a service agreement struct from the parameters', async () => {
        await h.initiateServiceAgreement(coordinator, agreement)
        await h.checkServiceAgreementPresent(coordinator, agreement)
      })

      it('returns the SAID', async () => {
        const sAID = await h.initiateServiceAgreementCall(
          coordinator,
          agreement,
        )
        assert.equal(sAID, agreement.id)
      })

      it('logs an event', async () => {
        await h.initiateServiceAgreement(coordinator, agreement)
        const event = await h.getLatestEvent(coordinator)
        assert.equal(agreement.id, event.args.said)
      })

      it('calls the aggregator with the SA info', async () => {
        await h.initiateServiceAgreement(coordinator, agreement)
        const event = await h.getLatestEvent(emptyAggregator)
        assert(event, 'event was expected')
        assert.equal('InitiatedJob', event.event)
        assert.equal(agreement.id, event.args.said)
      })
    })

    context('with an invalid oracle signatures', () => {
      let badOracleSignature, badRequestDigestAddr
      beforeEach(async () => {
        const sAID = h.generateSAID(agreement)
        badOracleSignature = await h.personalSign(h.stranger, sAID)
        badRequestDigestAddr = h.recoverPersonalSignature(
          sAID,
          badOracleSignature,
        )
        assert.equal(h.stranger.toLowerCase(), h.toHex(badRequestDigestAddr))
      })

      it('saves no service agreement struct, if signatures invalid', async () => {
        await h.assertActionThrows(async () => {
          await h.initiateServiceAgreement(
            coordinator,
            Object.assign(agreement, {
              oracleSignatures: [badOracleSignature],
            }),
          )
        })
        await h.checkServiceAgreementAbsent(coordinator, agreement.id)
      })
    })

    context('Validation of service agreement deadlines', () => {
      it('Rejects a service agreement with an endAt date in the past', async () => {
        await h.assertActionThrows(async () =>
          h.initiateServiceAgreement(
            coordinator,
            Object.assign(agreement, { endAt: 1 }),
          ),
        )
        await h.checkServiceAgreementAbsent(coordinator, agreement.id)
      })
    })
  })

  describe('#oracleRequest', () => {
    const to = '0x80e29acb842498fe6591f020bd82766dce619d43'
    let agreement, fHash

    beforeEach(async () => {
      fHash = h.functionSelectorFromAbi(GetterSetter, 'requestedBytes32')
      agreement = await newServiceAgreement(meanAggregator, {
        oracles: [h.oracleNode],
      })
      await h.initiateServiceAgreement(coordinator, agreement)
      await link.transfer(h.consumer, h.toWei(1000))
    })

    context('when called through the LINK token with enough payment', () => {
      let tx
      beforeEach(async () => {
        const payload = h.executeServiceAgreementBytes(
          agreement.id,
          to,
          fHash,
          '1',
          '',
        )
        tx = await link.transferAndCall(
          coordinator.address,
          agreement.payment,
          payload,
          { from: h.consumer },
        )
      })

      it('logs an event', async () => {
        const log = tx.receipt.rawLogs[2]
        assert.equal(
          coordinator.address.toLowerCase(),
          log.address.toLowerCase(),
        )

        // If updating this test, be sure to update
        // services.ServiceAgreementExecutionLogTopic. (Which see for the
        // calculation of this hash.)
        const eventSignature =
          '0xd8d7ecc4800d25fa53ce0372f13a416d98907a7ef3d8d3bdd79cf4fe75529c65'
        assert.equal(eventSignature, log.topics[0])

        assert.equal(agreement.id, log.topics[1])
        const req = h.decodeRunRequest(tx.receipt.rawLogs[2])
        assertBigNum(
          h.consumer,
          req.requester,
          "Logged consumer address doesn't match",
        )
        assertBigNum(
          agreement.payment,
          req.payment,
          "Logged payment amount doesn't match",
        )
      })
    })

    context(
      'when called through the LINK token with not enough payment',
      () => {
        it('throws an error', async () => {
          const calldata = h.executeServiceAgreementBytes(
            agreement.id,
            to,
            fHash,
            '1',
            '',
          )
          const underPaid = h
            .bigNum(agreement.payment)
            .sub(h.bigNum(1))
            .toString()

          await h.assertActionThrows(async () => {
            await link.transferAndCall(
              coordinator.address,
              underPaid,
              calldata,
              { from: h.consumer },
            )
          })
        })
      },
    )

    context('when not called through the LINK token', () => {
      it('reverts', async () => {
        await h.assertActionThrows(async () => {
          await coordinator.oracleRequest(
            '0x0000000000000000000000000000000000000000',
            0,
            agreement.id,
            to,
            fHash,
            1,
            1,
            '0x',
            { from: h.consumer },
          )
        }, /Must use LINK token/)
      })
    })
  })

  describe('#fulfillOracleRequest', () => {
    let agreement, mock, request
    beforeEach(async () => {
      agreement = await newServiceAgreement(meanAggregator, {
        oracles: [h.oracleNode],
      })
      const tx = await h.initiateServiceAgreement(coordinator, agreement)
      assert.equal(tx.logs[0].args.said, agreement.id)
    })

    const fHash = h.functionSelectorFromAbi(GetterSetter, 'requestedBytes32')

    context('cooperative consumer', () => {
      beforeEach(async () => {
        mock = await GetterSetter.new()
        const payload = h.executeServiceAgreementBytes(
          agreement.id,
          mock.address,
          fHash,
          1,
          '',
        )
        const tx = await link.transferAndCall(
          coordinator.address,
          agreement.payment,
          payload,
          { value: 0 },
        )
        request = h.decodeRunRequest(tx.receipt.rawLogs[2])
      })

      context('when called by a non-owner', () => {
        // Turn this test on when multiple-oracle response aggregation is enabled
        xit('raises an error', async () => {
          await h.assertActionThrows(async () => {
            await coordinator.fulfillOracleRequest(
              request.id,
              h.toHex('Hello World!'),
              { from: h.stranger },
            )
          })
        })
      })

      context('when called by an owner', () => {
        it('raises an error if the request ID does not exist', async () => {
          await h.assertActionThrows(async () => {
            await coordinator.fulfillOracleRequest(
              '0xdeadbeef',
              h.toHex('Hello World!'),
              { from: h.oracleNode },
            )
          })
        })

        it('sets the value on the requested contract', async () => {
          await coordinator.fulfillOracleRequest(
            request.id,
            h.toHex('Hello World!'),
            { from: h.oracleNode },
          )

          const mockRequestId = await mock.requestId.call()
          assert.equal(h.toHex(request.id), mockRequestId)

          const currentValue = await mock.getBytes32.call()
          assert.equal('Hello World!', h.toUtf8(currentValue))
        })

        it('reports errors from the aggregator, such as double-reporting', async () => {
          await coordinator.fulfillOracleRequest(
            request.id,
            h.toHex('First message!'),
            { from: h.oracleNode },
          )
          await h.assertActionThrows(
            async () =>
              coordinator.fulfillOracleRequest(
                request.id,
                h.toHex('Second message!!'),
                { from: h.oracleNode },
              ),
            /oracle already reported/,
          )
        })
      })
    })

    context('with a malicious requester', () => {
      const paymentAmount = h.toWei(1)

      beforeEach(async () => {
        mock = await MaliciousRequester.new(link.address, coordinator.address)
        await link.transfer(mock.address, paymentAmount)
      })

      xit('cannot cancel before the expiration', async () => {
        await h.assertActionThrows(async () => {
          await mock.maliciousRequestCancel(
            agreement.id,
            'doesNothing(bytes32,bytes32)',
          )
        })
      })

      it('cannot call functions on the LINK token through callbacks', async () => {
        await h.assertActionThrows(async () => {
          await mock.request(
            agreement.id,
            link.address,
            h.toHex('transfer(address,uint256)'),
          )
        })
      })

      context('requester lies about amount of LINK sent', () => {
        it('the oracle uses the amount of LINK actually paid', async () => {
          const tx = await mock.maliciousPrice(agreement.id)
          const req = h.decodeRunRequest(tx.receipt.rawLogs[3])
          assertBigNum(
            paymentAmount,
            req.payment,
            [
              'Malicious data request tricked oracle into refunding more than',
              'the requester paid, by claiming a larger amount',
              `(${req.payment}) than the requester paid (${paymentAmount})`,
            ].join(' '),
          )
        })
      })
    })

    context('with a malicious consumer', () => {
      const paymentAmount = h.toWei(1)

      beforeEach(async () => {
        mock = await MaliciousConsumer.new(link.address, coordinator.address)
        await link.transfer(mock.address, paymentAmount)
      })

      context('fails during fulfillment', () => {
        beforeEach(async () => {
          const tx = await mock.requestData(
            agreement.id,
            h.toHex('assertFail(bytes32,bytes32)'),
          )
          request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        })

        // needs coordinator withdrawal functionality to meet parity
        xit('allows the oracle node to receive their payment', async () => {
          await coordinator.fulfillOracleRequest(
            request.id,
            h.toHex('hack the planet 101'),
            { from: h.oracleNode },
          )

          const balance = await link.balanceOf.call(h.oracleNode)
          assert.isTrue(balance.equals(0))

          await coordinator.withdraw(h.oracleNode, paymentAmount, {
            from: h.oracleNode,
          })
          const newBalance = await link.balanceOf.call(h.oracleNode)
          assert.isTrue(paymentAmount.equals(newBalance))
        })

        it("can't fulfill the data again", async () => {
          coordinator.fulfillOracleRequest(
            request.id,
            h.toHex('hack the planet 101'),
            { from: h.oracleNode },
          )
          await h.assertActionThrows(
            async () =>
              await coordinator.fulfillOracleRequest(
                request.id,
                h.toHex('hack the planet 102'),
                { from: h.oracleNode },
              ),
            /oracle already reported/,
          )
        })
      })

      context('calls selfdestruct', () => {
        beforeEach(async () => {
          const tx = await mock.requestData(
            agreement.id,
            'doesNothing(bytes32,bytes32)',
          )
          request = h.decodeRunRequest(tx.receipt.rawLogs[3])
          await mock.remove()
        })

        // needs coordinator withdrawal functionality to meet parity
        xit('allows the oracle node to receive their payment', async () => {
          await coordinator.fulfillOracleRequest(
            request.id,
            h.toHex('hack the planet 101'),
            { from: h.oracleNode },
          )

          const balance = await link.balanceOf.call(h.oracleNode)
          assert.isTrue(balance.equals(0))

          await coordinator.withdraw(h.oracleNode, paymentAmount, {
            from: h.oracleNode,
          })
          const newBalance = await link.balanceOf.call(h.oracleNode)
          assert.isTrue(paymentAmount.equals(newBalance))
        })
      })

      context('request is canceled during fulfillment', () => {
        beforeEach(async () => {
          const tx = await mock.requestData(
            agreement.id,
            h.toHex('cancelRequestOnFulfill(bytes32,bytes32)'),
          )
          request = h.decodeRunRequest(tx.receipt.rawLogs[3])

          const mockBalance = await link.balanceOf.call(mock.address)
          assertBigNum(mockBalance, h.bigNum(0))
        })

        // needs coordinator withdrawal functionality to meet parity
        xit('allows the oracle node to receive their payment', async () => {
          await coordinator.fulfillOracleRequest(
            request.id,
            h.toHex('hack the planet 101'),
            { from: h.oracleNode },
          )

          const mockBalance = await link.balanceOf.call(mock.address)
          assertBigNum(mockBalance, h.bigNum(0))

          const balance = await link.balanceOf.call(h.oracleNode)
          assert.isTrue(balance.equals(0))

          await coordinator.withdraw(h.oracleNode, paymentAmount, {
            from: h.oracleNode,
          })
          const newBalance = await link.balanceOf.call(h.oracleNode)
          assert.isTrue(paymentAmount.equals(newBalance))
        })

        it("can't fulfill the data again", async () => {
          await coordinator.fulfillOracleRequest(
            request.id,
            h.toHex('hack the planet 101'),
            { from: h.oracleNode },
          )
          await h.assertActionThrows(async () => {
            await coordinator.fulfillOracleRequest(
              request.id,
              h.toHex('hack the planet 102'),
              { from: h.oracleNode },
            )
          })
        })
      })
    })

    context('when aggregating answers', () => {
      let oracle1, oracle2, oracle3, request, strangerOracle

      beforeEach(async () => {
        strangerOracle = h.stranger
        oracle1 = h.oracleNode1
        oracle2 = h.oracleNode2
        oracle3 = h.oracleNode3

        agreement = await newServiceAgreement(meanAggregator, {
          oracles: [oracle1, oracle2, oracle3],
        })
        let tx = await h.initiateServiceAgreement(coordinator, agreement)
        assert.equal(tx.logs[0].args.said, agreement.id)

        mock = await GetterSetter.new()
        const fHash = h.functionSelectorFromAbi(
          GetterSetter,
          'requestedUint256',
        )

        const payload = h.executeServiceAgreementBytes(
          agreement.id,
          mock.address,
          fHash,
          1,
          '',
        )
        tx = await link.transferAndCall(
          coordinator.address,
          agreement.payment,
          payload,
          { value: 0 },
        )
        request = h.decodeRunRequest(tx.receipt.rawLogs[2])
      })

      it('does not set the value with only one oracle', async () => {
        const tx = await coordinator.fulfillOracleRequest(
          request.id,
          h.toHex(17),
          { from: oracle1 },
        )
        assert.equal(tx.receipt.rawLogs.length, 0) // No logs emitted = consuming contract not called
      })

      it('sets the average of the reported values', async () => {
        await coordinator.fulfillOracleRequest(request.id, h.toHex(16), {
          from: oracle1,
        })
        await coordinator.fulfillOracleRequest(request.id, h.toHex(17), {
          from: oracle2,
        })
        const lastTx = await coordinator.fulfillOracleRequest(
          request.id,
          h.toHex(18),
          { from: oracle3 },
        )

        assert.equal(lastTx.receipt.rawLogs.length, 1)
        const currentValue = await mock.getUint256.call()
        assertBigNum(h.bigNum(17), currentValue)
      })

      context('when large values are provided in response', async () => {
        // (uint256(-1) / 2) - 1
        const largeValue1 =
          '0x7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe'
        // (uint256(-1) / 2)
        const largeValue2 =
          '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
        // (uint256(-1) / 2) + 1
        const largeValue3 =
          '0x8000000000000000000000000000000000000000000000000000000000000000'

        beforeEach(async () => {
          await coordinator.fulfillOracleRequest(request.id, largeValue1, {
            from: oracle1,
          })
          await coordinator.fulfillOracleRequest(request.id, largeValue2, {
            from: oracle2,
          })
        })

        it('does not overflow', async () => {
          await coordinator.fulfillOracleRequest(request.id, largeValue3, {
            from: oracle3,
          })
        })

        it('sets the average of the reported values', async () => {
          await coordinator.fulfillOracleRequest(request.id, largeValue3, {
            from: oracle3,
          })
          const currentValue = await mock.getUint256.call()
          assertBigNum(h.bigNum(largeValue2), currentValue)
          assert.notEqual(0, await mock.requestId.call()) // check if called
        })
      })

      it('successfully sets average when responses equal largest uint256', async () => {
        const largest =
          '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

        await coordinator.fulfillOracleRequest(request.id, largest, {
          from: oracle1,
        })
        await coordinator.fulfillOracleRequest(request.id, largest, {
          from: oracle2,
        })
        await coordinator.fulfillOracleRequest(request.id, largest, {
          from: oracle3,
        })
        const currentValue = await mock.getUint256.call()
        assertBigNum(h.bigNum(largest), currentValue)
        assert.notEqual(0, await mock.requestId.call()) // check if called
      })

      it('rejects oracles not part of the service agreement', async () => {
        await h.assertActionThrows(async () => {
          await coordinator.fulfillOracleRequest(request.id, h.toHex(18), {
            from: strangerOracle,
          })
        })
      })

      context('when an oracle reports multiple times', async () => {
        beforeEach(async () => {
          await coordinator.fulfillOracleRequest(request.id, h.toHex(16), {
            from: oracle1,
          })
          await coordinator.fulfillOracleRequest(request.id, h.toHex(17), {
            from: oracle2,
          })

          await h.assertActionThrows(async () => {
            await coordinator.fulfillOracleRequest(request.id, h.toHex(18), {
              from: oracle2,
            })
          })
        })

        it('does not set the average', async () => {
          assert.equal(0, await mock.requestId.call()) // check if called
        })

        it('still allows the other oracles to report', async () => {
          await coordinator.fulfillOracleRequest(request.id, h.toHex(18), {
            from: oracle3,
          })
          const currentValue = await mock.getUint256.call()
          assertBigNum(h.bigNum(17), currentValue)
          assert.notEqual(0, await mock.requestId.call()) // check if called
        })
      })
    })

    context('after aggregation', () => {
      let oracle1, oracle2, oracle3, request

      beforeEach(async () => {
        oracle1 = h.oracleNode1
        oracle2 = h.oracleNode2
        oracle3 = h.oracleNode3

        agreement = await newServiceAgreement(meanAggregator, {
          oracles: [oracle1, oracle2, oracle3],
        })
        let tx = await h.initiateServiceAgreement(coordinator, agreement)
        assert.equal(tx.logs[0].args.said, agreement.id)

        mock = await GetterSetter.new()
        const fHash = h.functionSelectorFromAbi(
          GetterSetter,
          'requestedUint256',
        )

        const payload = h.executeServiceAgreementBytes(
          agreement.id,
          mock.address,
          fHash,
          1,
          '',
        )
        tx = await link.transferAndCall(
          coordinator.address,
          agreement.payment,
          payload,
          { value: 0 },
        )
        request = h.decodeRunRequest(tx.receipt.rawLogs[2])

        await coordinator.fulfillOracleRequest(request.id, h.toHex(16), {
          from: oracle1,
        })
        await coordinator.fulfillOracleRequest(request.id, h.toHex(17), {
          from: oracle2,
        })
        await coordinator.fulfillOracleRequest(request.id, h.toHex(18), {
          from: oracle3,
        })

        const currentValue = await mock.getUint256.call()
        assertBigNum(h.bigNum(17), currentValue)
      })

      it('oracle balances are updated', async () => {
        // Given the 3 oracles from the SA, each should have the following balance after fulfillment
        const expected1 = h.bigNum('555555555555555555')
        const expected2 = h.bigNum('333333333333333333')
        const expected3 = h.bigNum('111111111111111111')
        const balance1 = await coordinator.withdrawableTokens.call(oracle1)
        const balance2 = await coordinator.withdrawableTokens.call(oracle2)
        const balance3 = await coordinator.withdrawableTokens.call(oracle3)
        assertBigNum(expected1, balance1)
        assertBigNum(expected2, balance2)
        assertBigNum(expected3, balance3)
      })
    })

    context('withdraw', () => {
      let oracle1, oracle2, oracle3, request

      beforeEach(async () => {
        oracle1 = h.oracleNode1
        oracle2 = h.oracleNode2
        oracle3 = h.oracleNode3

        agreement = await newServiceAgreement(meanAggregator, {
          oracles: [oracle1, oracle2, oracle3],
        })
        let tx = await h.initiateServiceAgreement(coordinator, agreement)
        assert.equal(tx.logs[0].args.said, agreement.id)

        mock = await GetterSetter.new()
        const fHash = h.functionSelectorFromAbi(
          GetterSetter,
          'requestedUint256',
        )

        const payload = h.executeServiceAgreementBytes(
          agreement.id,
          mock.address,
          fHash,
          1,
          '',
        )
        tx = await link.transferAndCall(
          coordinator.address,
          agreement.payment,
          payload,
          { value: 0 },
        )
        request = h.decodeRunRequest(tx.receipt.rawLogs[2])

        await coordinator.fulfillOracleRequest(request.id, h.toHex(16), {
          from: oracle1,
        })
        await coordinator.fulfillOracleRequest(request.id, h.toHex(17), {
          from: oracle2,
        })
        await coordinator.fulfillOracleRequest(request.id, h.toHex(18), {
          from: oracle3,
        })

        const currentValue = await mock.getUint256.call()
        assertBigNum(h.bigNum(17), currentValue)
      })

      it('allows the oracle to withdraw their full amount', async () => {
        const coordBalance1 = await link.balanceOf.call(coordinator.address)
        const withdrawAmount = await coordinator.withdrawableTokens.call(
          oracle1,
        )
        await coordinator.withdraw(oracle1, withdrawAmount.toString(), {
          from: oracle1,
        })
        const oracleBalance = await link.balanceOf.call(oracle1)
        const afterWithdrawBalance = await coordinator.withdrawableTokens.call(
          oracle1,
        )
        const coordBalance2 = await link.balanceOf.call(coordinator.address)
        const expectedCoordFinalBalance = coordBalance1.sub(withdrawAmount)
        assertBigNum(withdrawAmount, oracleBalance)
        assertBigNum(expectedCoordFinalBalance, coordBalance2)
        assertBigNum(h.bigNum(0), afterWithdrawBalance)
      })

      it('rejects amounts greater than allowed', async () => {
        const oracleBalance = await coordinator.withdrawableTokens.call(oracle1)
        const withdrawAmount = oracleBalance.add(h.bigNum(1))
        await h.assertActionThrows(async () => {
          await coordinator.withdraw(oracle1, withdrawAmount.toString(), {
            from: oracle1,
          })
        })
      })
    })
  })

  describe('#depositFunds', async () => {
    let oracle

    const assertBalances = async ({ link: linkBal, coordinator: coordBal }) => {
      const linkBalance = await link.balanceOf(oracle)
      const coordinatorBalance = await coordinator.balanceOf(oracle)
      assert.equal(linkBalance, linkBal)
      assert.equal(coordinatorBalance, coordBal)
    }

    beforeEach(async () => {
      oracle = h.oracleNode
      await link.transfer(oracle, 4)
      const initialBalance = await link.balanceOf(oracle)
      assert.equal(initialBalance, 4)
    })

    it('permits deposit through link#transferAndCall', async () => {
      const payload = h.depositFundsBytes(oracle, 1)
      await link.transferAndCall(coordinator.address, 1, payload, {
        from: oracle,
      })
      await assertBalances({ link: 3, coordinator: 1 })
    })

    it('overrides invalid payloads', async () => {
      const payload = h.depositFundsBytes(coordinator.address, 2) // wrong value and address
      await link.transferAndCall(coordinator.address, 1, payload, {
        from: oracle,
      })
      await assertBalances({ link: 3, coordinator: 1 })
    })

    it('reverts with insufficient payloads', async () => {
      const payload = h.functionSelector('depositFunds(address,uint256)')
      await h.assertActionThrows(async () => {
        await link.transferAndCall(coordinator.address, 1, payload, {
          from: oracle,
        })
      })
    })

    it('allows partial withdrawals', async () => {
      const payload = h.depositFundsBytes(oracle, 4)
      await link.transferAndCall(coordinator.address, 4, payload, {
        from: oracle,
      })
      await coordinator.withdraw(oracle, 1, { from: oracle })
      await assertBalances({ link: 1, coordinator: 3 })
    })

    it('allows full withdrawals', async () => {
      const payload = h.depositFundsBytes(oracle, 4)
      await link.transferAndCall(coordinator.address, 4, payload, {
        from: oracle,
      })
      await coordinator.withdraw(oracle, 2, { from: oracle })
      await coordinator.withdraw(oracle, 2, { from: oracle })
      await assertBalances({ link: 4, coordinator: 0 })
    })

    it('reverts when overdrawing', async () => {
      const payload = h.depositFundsBytes(oracle, 4)
      await link.transferAndCall(coordinator.address, 4, payload, {
        from: oracle,
      })
      await coordinator.withdraw(oracle, 4, { from: oracle })
      await h.assertActionThrows(async () => {
        await coordinator.withdraw(oracle, 1, { from: oracle })
      })
      await assertBalances({ link: 4, coordinator: 0 })
    })
  })
})
